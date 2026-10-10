/**
 * Persists legacy card conversations for the frozen mobile app's chat routes.
 *
 * The card chat worker that answered queued questions has been removed; the
 * web app asks about cards in workspace chat. These functions remain so the
 * mobile API routes and saved chat links keep compiling and reading history.
 */

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  isAiProviderId,
} from "../lib/ai-model-settings"
import { resolveQueuedAiSelection } from "./ai_provider_settings"

/** Maximum size accepted for a learner question. */
export const MAX_CHAT_QUESTION_LENGTH = 2_000

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
