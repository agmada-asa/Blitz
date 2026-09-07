/** Persists card conversations and exposes a leased queue for the local chat worker. */

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  isAiProviderId,
} from "../lib/ai-model-settings"
import { resolveQueuedAiSelection } from "./ai-provider-settings"

/** Maximum size accepted for a learner question. */
export const MAX_CHAT_QUESTION_LENGTH = 2_000
/** Maximum size returned for a stored reply or failure detail. */
export const MAX_CHAT_REPLY_LENGTH = 250_000
/** Time a local worker owns a chat request before another worker may recover it. */
export const CHAT_LEASE_MS = 5 * 60 * 1_000
/** Maximum queued or expired records inspected by one claim. */
const CLAIM_SCAN_LIMIT = 50

/** Bounds user text at the persistence boundary and returns its trimmed value. */
function boundedText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > maximum) throw new Error(`${label} is too long`)
  return trimmed
}

/** Validates a provider stored on a conversation while preserving legacy rows. */
function providerSelection(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const provider = boundedText(value, "Provider", 80)
  if (!isAiProviderId(provider)) throw new Error("Provider is not supported")
  return provider
}

/** Requires that a project and learning item belong together. */
async function requireItem(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  itemId: Id<"learningItems">
): Promise<Doc<"learningItems">> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
  const item = await ctx.db.get(itemId)
  if (!item || item.projectId !== projectId)
    throw new Error("Learning item does not belong to project")
  return item
}

/** Finds the one conversation for a project and learning item. */
async function findConversation(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  itemId: Id<"learningItems">
): Promise<Doc<"conversations"> | null> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_project_item", (q) =>
      q.eq("projectId", projectId).eq("itemId", itemId)
    )
    .take(1)
  return rows[0] ?? null
}

/** Converts a persisted message into the safe polling response shape. */
function messageForClient(message: Doc<"conversationMessages">) {
  return {
    id: message._id,
    clientMessageId: message.clientMessageId,
    question: message.question,
    status: message.status,
    ...(message.reply === undefined ? {} : { reply: message.reply }),
    ...(message.error === undefined ? {} : { error: message.error }),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }
}

/** Resolves only the card identity and attribution needed to reopen a saved chat. */
export const getAttachment = query({
  args: { projectId: v.id("projects"), itemId: v.id("learningItems") },
  handler: async (ctx, args) => {
    const item = await requireItem(ctx, args.projectId, args.itemId)
    const sources = await Promise.all(
      item.sourceIds.slice(0, 3).map((id) => ctx.db.get(id))
    )
    return {
      id: item._id,
      projectId: item.projectId,
      title: item.title,
      sourceLabel:
        sources
          .filter(
            (source) => source !== null && source.projectId === args.projectId
          )
          .map((source) => source!.filename)
          .join(", ") || "Source unavailable",
    }
  },
})

/** Enqueues an idempotent learner question for one project card. */
export const enqueue = mutation({
  args: {
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    clientMessageId: v.string(),
    question: v.string(),
  },
  handler: async (ctx, args) => {
    await requireItem(ctx, args.projectId, args.itemId)
    const clientMessageId = boundedText(
      args.clientMessageId,
      "Client message id",
      200
    )
    const question = boundedText(
      args.question,
      "Question",
      MAX_CHAT_QUESTION_LENGTH
    )
    const selection = await resolveQueuedAiSelection(ctx, "reply")
    const now = Date.now()
    let conversation = await findConversation(ctx, args.projectId, args.itemId)
    if (!conversation) {
      const conversationId = await ctx.db.insert("conversations", {
        projectId: args.projectId,
        itemId: args.itemId,
        providerId: selection.providerId,
        providerModel: selection.model,
        providerEffort: selection.effort,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      })
      conversation = await ctx.db.get(conversationId)
      if (!conversation) throw new Error("Conversation could not be created")
    }
    const storedProvider =
      providerSelection(conversation.providerId) ??
      (conversation.codexThreadId ? "codex" : undefined)
    const providerId = storedProvider ?? selection.providerId
    const providerModel =
      conversation.providerModel ??
      (providerId === "codex"
        ? DEFAULT_AI_MODEL_SETTINGS.replyModel
        : selection.model)
    const providerEffort =
      conversation.providerEffort ??
      (providerId === "codex"
        ? DEFAULT_AI_MODEL_SETTINGS.replyEffort
        : selection.effort)
    await ctx.db.patch(conversation._id, {
      providerId,
      providerModel,
      providerEffort,
      updatedAt: now,
    })
    const existing = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation_clientMessageId", (q) =>
        q
          .eq("conversationId", conversation!._id)
          .eq("clientMessageId", clientMessageId)
      )
      .take(1)
    if (existing[0]) {
      if (existing[0].question !== question)
        throw new Error(
          "Client message id payload conflicts with stored message"
        )
      return {
        conversationId: conversation._id,
        message: messageForClient(existing[0]),
        alreadyQueued: true,
      }
    }
    const messageId = await ctx.db.insert("conversationMessages", {
      conversationId: conversation._id,
      clientMessageId,
      question,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(conversation._id, {
      status: conversation.status === "running" ? "running" : "queued",
      lastError: undefined,
      updatedAt: now,
    })
    const message = await ctx.db.get(messageId)
    if (!message) throw new Error("Message could not be created")
    return {
      conversationId: conversation._id,
      message: messageForClient(message),
      alreadyQueued: false,
    }
  },
})

/** Returns one conversation and its messages without exposing source material. */
export const get = query({
  args: { projectId: v.id("projects"), itemId: v.id("learningItems") },
  handler: async (ctx, args) => {
    await requireItem(ctx, args.projectId, args.itemId)
    const conversation = await findConversation(
      ctx,
      args.projectId,
      args.itemId
    )
    if (!conversation)
      return {
        conversationId: null,
        providerId: null,
        providerModel: null,
        providerEffort: null,
        providerSessionId: null,
        codexThreadId: null,
        status: "idle" as const,
        lastError: null,
        messages: [],
      }
    const messages = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation_createdAt", (q) =>
        q.eq("conversationId", conversation._id)
      )
      .order("asc")
      .collect()
    return {
      conversationId: conversation._id,
      providerId:
        providerSelection(conversation.providerId) ??
        (conversation.codexThreadId ? "codex" : null),
      providerModel: conversation.providerModel ?? null,
      providerEffort: conversation.providerEffort ?? null,
      providerSessionId:
        conversation.providerSessionId ?? conversation.codexThreadId ?? null,
      codexThreadId: conversation.codexThreadId ?? null,
      status: conversation.status,
      lastError: conversation.lastError ?? null,
      messages: messages.map(messageForClient),
    }
  },
})

/** Claims one queued or expired chat request for a named local worker. */
export const claimNext = mutation({
  args: { workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const workerId = boundedText(args.workerId, "Worker id", 200)
    const leaseToken = boundedText(args.leaseToken, "Lease token", 200)
    const now = Date.now()
    const queued = await ctx.db
      .query("conversationMessages")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const running = await ctx.db
      .query("conversationMessages")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const candidates = [...queued, ...running]
      .filter(
        (message) =>
          message.status === "queued" ||
          (message.leaseExpiresAt !== undefined &&
            message.leaseExpiresAt <= now)
      )
      .sort((left, right) => left.createdAt - right.createdAt)
    for (const candidate of candidates) {
      const conversation = await ctx.db.get(candidate.conversationId)
      if (!conversation) continue
      if (
        conversation.activeMessageId &&
        conversation.activeMessageId !== candidate._id &&
        conversation.status === "running"
      )
        continue
      const item = await ctx.db.get(conversation.itemId)
      if (!item || item.projectId !== conversation.projectId) continue
      const expiresAt = now + CHAT_LEASE_MS
      await ctx.db.patch(candidate._id, {
        status: "running",
        workerId,
        leaseToken,
        leaseExpiresAt: expiresAt,
        reply: undefined,
        error: undefined,
        updatedAt: now,
      })
      await ctx.db.patch(conversation._id, {
        status: "running",
        activeMessageId: candidate._id,
        lastError: undefined,
        updatedAt: now,
      })
      return {
        messageId: candidate._id,
        conversationId: conversation._id,
        projectId: conversation.projectId,
        itemId: conversation.itemId,
        providerId:
          providerSelection(conversation.providerId) ??
          (conversation.codexThreadId ? "codex" : undefined),
        providerInstanceId: conversation.providerInstanceId ?? null,
        providerSessionId:
          conversation.providerSessionId ?? conversation.codexThreadId ?? null,
        providerModel: conversation.providerModel ?? null,
        providerEffort: conversation.providerEffort ?? null,
        codexThreadId: conversation.codexThreadId ?? null,
        leaseToken,
        question: candidate.question,
      }
    }
    return null
  },
})

/** Loads card and preparation data only after a live worker lease is verified. */
export const getWorkContext = query({
  args: { messageId: v.id("conversationMessages"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId)
    if (
      !message ||
      message.status !== "running" ||
      message.leaseToken !== args.leaseToken ||
      (message.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Chat lease is missing or expired")
    const conversation = await ctx.db.get(message.conversationId)
    if (!conversation || conversation.activeMessageId !== message._id)
      throw new Error("Chat conversation is no longer active")
    const item = await requireItem(
      ctx,
      conversation.projectId,
      conversation.itemId
    )
    if (!item.sourceChunkId)
      throw new Error("Card source chunk is not available for chat")
    const chunk = await ctx.db.get(item.sourceChunkId)
    if (!chunk) throw new Error("Card source chunk was not found")
    const job = await ctx.db.get(chunk.jobId)
    if (
      !job ||
      job.projectId !== conversation.projectId ||
      job.sourceId !== chunk.sourceId
    )
      throw new Error("Card source preparation snapshot was not found")
    const source = await ctx.db.get(chunk.sourceId)
    if (!source || source.projectId !== conversation.projectId)
      throw new Error("Card source was not found")
    if (
      item.sourceChunkOrdinal !== undefined &&
      item.sourceChunkOrdinal !== chunk.ordinal
    )
      throw new Error("Card source chunk ordinal no longer matches")
    return {
      projectId: conversation.projectId,
      itemId: item._id,
      item: {
        id: String(item._id),
        title: item.title,
        body: item.body,
        ...(item.question === undefined ? {} : { question: item.question }),
        ...(item.options === undefined
          ? {}
          : { options: item.options.map((option) => option.text) }),
        sourceLabel: source.filename,
      },
      source: {
        id: String(source._id),
        filename: job.sourceFilename,
        kind: job.sourceKind,
        extractedText: job.sourceTextSnapshot,
        chunkOrdinal: chunk.ordinal,
        chunkId: chunk.chunkId,
      },
      question: message.question,
    }
  },
})

/** Publishes cumulative assistant text only for the current, unexpired worker lease. */
export const progress = mutation({
  args: {
    messageId: v.id("conversationMessages"),
    leaseToken: v.string(),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.reply.length > MAX_CHAT_REPLY_LENGTH)
      throw new Error("Reply is too long")
    const message = await ctx.db.get(args.messageId)
    if (
      !message ||
      message.status !== "running" ||
      message.leaseToken !== args.leaseToken ||
      (message.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Chat lease is missing or expired")
    const conversation = await ctx.db.get(message.conversationId)
    if (!conversation || conversation.activeMessageId !== message._id)
      throw new Error("Chat conversation is no longer active")
    // A delayed duplicate snapshot must never shorten an answer already displayed.
    if (args.reply.length < (message.reply?.length ?? 0)) return
    await ctx.db.patch(message._id, {
      reply: args.reply,
      updatedAt: Date.now(),
    })
  },
})

/** Atomically stores assistant text and provider identifiers for a live request. */
export const complete = mutation({
  args: {
    messageId: v.id("conversationMessages"),
    leaseToken: v.string(),
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerTurnId: v.optional(v.string()),
    codexThreadId: v.optional(v.string()),
    codexTurnId: v.optional(v.string()),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    const reply = boundedText(args.reply, "Reply", MAX_CHAT_REPLY_LENGTH)
    const message = await ctx.db.get(args.messageId)
    if (
      !message ||
      message.status !== "running" ||
      message.leaseToken !== args.leaseToken ||
      (message.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Chat lease is missing or expired")
    const conversation = await ctx.db.get(message.conversationId)
    if (!conversation || conversation.activeMessageId !== message._id)
      throw new Error("Chat conversation is no longer active")
    const storedProvider =
      providerSelection(conversation.providerId) ??
      (conversation.codexThreadId ? "codex" : undefined)
    const providerId =
      providerSelection(args.providerId) ?? storedProvider ?? "codex"
    if (storedProvider && providerId !== storedProvider)
      throw new Error("A card conversation cannot change its provider")
    const providerSessionId = boundedText(
      args.providerSessionId ?? args.codexThreadId ?? "",
      "Provider session id",
      200
    )
    const providerTurnId = boundedText(
      args.providerTurnId ?? args.codexTurnId ?? "",
      "Provider turn id",
      200
    )
    const now = Date.now()
    await ctx.db.patch(message._id, {
      status: "completed",
      reply,
      providerTurnId,
      ...(args.codexTurnId
        ? { codexTurnId: boundedText(args.codexTurnId, "Codex turn id", 200) }
        : {}),
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
    await ctx.db.patch(conversation._id, {
      status: "idle",
      providerId,
      ...(args.providerInstanceId
        ? {
            providerInstanceId: boundedText(
              args.providerInstanceId,
              "Provider instance",
              200
            ),
          }
        : {}),
      providerSessionId,
      ...(args.codexThreadId
        ? {
            codexThreadId: boundedText(
              args.codexThreadId,
              "Codex thread id",
              200
            ),
          }
        : {}),
      activeMessageId: undefined,
      lastError: undefined,
      updatedAt: now,
    })
    return { status: "completed" as const }
  },
})

/** Records a bounded failure while preserving the question for deliberate retry. */
export const fail = mutation({
  args: {
    messageId: v.id("conversationMessages"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId)
    if (
      !message ||
      message.status !== "running" ||
      message.leaseToken !== args.leaseToken ||
      (message.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Chat lease is missing or expired")
    const conversation = await ctx.db.get(message.conversationId)
    if (!conversation || conversation.activeMessageId !== message._id)
      throw new Error("Chat conversation is no longer active")
    const now = Date.now()
    const error = boundedText(args.error, "Chat error", 1_000)
    await ctx.db.patch(message._id, {
      status: "failed",
      error,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
    await ctx.db.patch(conversation._id, {
      status: "failed",
      activeMessageId: undefined,
      lastError: error,
      updatedAt: now,
    })
    return { status: "failed" as const }
  },
})

/** Requeues one failed message only when the caller explicitly requests retry. */
export const retry = mutation({
  args: {
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    messageId: v.id("conversationMessages"),
  },
  handler: async (ctx, args) => {
    await requireItem(ctx, args.projectId, args.itemId)
    const message = await ctx.db.get(args.messageId)
    const conversation = await findConversation(
      ctx,
      args.projectId,
      args.itemId
    )
    if (
      !message ||
      !conversation ||
      message.conversationId !== conversation._id
    )
      throw new Error("Conversation message was not found")
    if (message.status !== "failed")
      throw new Error("Only failed messages can be retried")
    if (conversation.status === "running")
      throw new Error("Conversation already has an active turn")
    await ctx.db.patch(message._id, {
      status: "queued",
      reply: undefined,
      error: undefined,
      updatedAt: Date.now(),
    })
    await ctx.db.patch(conversation._id, {
      status: "queued",
      lastError: undefined,
      updatedAt: Date.now(),
    })
    return { status: "queued" as const }
  },
})
