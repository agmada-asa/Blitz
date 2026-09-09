/** Persists general Blitz chats, messages, attachments, and streaming progress. */

import { mutation, query, type MutationCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { AI_PROVIDER_IDS } from "../lib/ai-model-settings"

/** Maximum idle time before a stranded running turn can be replaced. */
const STALE_TURN_MS = 2 * 60 * 1_000
/** Maximum assistant reply retained for one persisted message. */
const MAX_REPLY_LENGTH = 250_000
/** Maximum earlier transcript text returned when a Codex thread needs recovery. */
const MAX_REPLAY_MESSAGE_CHARACTERS = 32_000
/** Maximum earlier messages returned when a Codex thread needs recovery. */
const MAX_REPLAY_MESSAGES = 24
/** Maximum earlier context items returned when a Codex thread needs recovery. */
const MAX_REPLAY_ATTACHMENTS = 8
/** Maximum inline context text returned when a Codex thread needs recovery. */
const MAX_REPLAY_ATTACHMENT_CHARACTERS = 96_000
/** Maximum messages copied into a user-created chat branch. */
const MAX_BRANCH_MESSAGES = 200
/** Maximum attachments copied into a user-created chat branch. */
const MAX_BRANCH_ATTACHMENTS = 100

/** Validates a requested provider without trusting the client to name arbitrary commands. */
function providerSelection(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const provider = boundedText(value, "Provider", 80)
  if (!AI_PROVIDER_IDS.includes(provider as (typeof AI_PROVIDER_IDS)[number]))
    throw new Error("Provider is not supported")
  return provider
}

/** Resolves the provider already bound to a chat, including legacy Codex sessions. */
function persistedChatProvider(
  chat: Pick<Doc<"workspaceChats">, "providerId" | "codexThreadId">
): string | undefined {
  return (
    providerSelection(chat.providerId) ??
    (chat.codexThreadId ? "codex" : undefined)
  )
}

/** Validator shared by card, file, link, and project context records. */
const attachmentInput = v.object({
  documentId: v.optional(v.id("chatDocuments")),
  kind: v.union(
    v.literal("card"),
    v.literal("project"),
    v.literal("file"),
    v.literal("link")
  ),
  label: v.string(),
  projectId: v.optional(v.id("projects")),
  itemId: v.optional(v.id("learningItems")),
  text: v.optional(v.string()),
  url: v.optional(v.string()),
})

/** Trims a required value and rejects text outside its persistence bound. */
function boundedText(value: string, label: string, maximum: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} is required`)
  if (text.length > maximum) throw new Error(`${label} is too long`)
  return text
}

/** Derives a compact stable title from the first user message. */
function titleForMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]!.trim().replace(/\s+/g, " ")
  return firstLine.length <= 64
    ? firstLine
    : `${firstLine.slice(0, 63).trimEnd()}…`
}

/** Adds a compact branch marker without exceeding the chat title bound. */
function titleForBranch(title: string): string {
  const suffix = " · branch"
  return `${title.slice(0, 64 - suffix.length).trimEnd()}${suffix}`
}

/** Selects the newest bounded transcript slice and restores chronological order. */
function replayMessages(messages: Doc<"workspaceChatMessages">[]): Array<{
  role: "user" | "assistant"
  content: string
  status: "running" | "completed" | "failed"
}> {
  let remaining = MAX_REPLAY_MESSAGE_CHARACTERS
  const selected: Array<{
    role: "user" | "assistant"
    content: string
    status: "running" | "completed" | "failed"
  }> = []
  for (const message of messages) {
    if (remaining <= 0) break
    const content = message.content.slice(0, Math.min(8_000, remaining))
    if (!content) continue
    selected.push({
      role: message.role,
      content,
      status: message.status,
    })
    remaining -= content.length
  }
  return selected.reverse()
}

/** Selects bounded project, card, file, and link context for thread recovery. */
function replayAttachments(attachments: Doc<"workspaceChatAttachments">[]): {
  card?: { projectId: Id<"projects">; itemId: Id<"learningItems"> }
  projectIds: Id<"projects">[]
  attachments: Array<{
    kind: "file" | "link"
    label: string
    text: string
    url?: string
  }>
} {
  let remaining = MAX_REPLAY_ATTACHMENT_CHARACTERS
  let card:
    { projectId: Id<"projects">; itemId: Id<"learningItems"> } | undefined
  const projectIds: Id<"projects">[] = []
  const inline: Array<{
    kind: "file" | "link"
    label: string
    text: string
    url?: string
  }> = []
  for (const attachment of attachments) {
    if (
      attachment.kind === "card" &&
      attachment.projectId &&
      attachment.itemId
    ) {
      card ??= {
        projectId: attachment.projectId,
        itemId: attachment.itemId,
      }
      continue
    }
    if (attachment.kind === "project" && attachment.projectId) {
      if (!projectIds.includes(attachment.projectId))
        projectIds.push(attachment.projectId)
      continue
    }
    if (
      (attachment.kind !== "file" && attachment.kind !== "link") ||
      !attachment.text ||
      remaining <= 0
    )
      continue
    const text = attachment.text.slice(0, Math.min(24_000, remaining))
    inline.push({
      kind: attachment.kind,
      label: attachment.label,
      text,
      ...(attachment.url ? { url: attachment.url } : {}),
    })
    remaining -= text.length
  }
  return {
    ...(card ? { card } : {}),
    projectIds: projectIds.slice(0, 3),
    attachments: inline.reverse(),
  }
}

/** Returns chat summaries in most-recently-active order for the history sidebar. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const [pinnedChats, recentChats] = await Promise.all([
      ctx.db
        .query("workspaceChats")
        .withIndex("by_pinned_updatedAt", (index) => index.eq("isPinned", true))
        .order("desc")
        .take(60),
      ctx.db
        .query("workspaceChats")
        .withIndex("by_updatedAt")
        .order("desc")
        .take(60),
    ])
    const seen = new Set<Id<"workspaceChats">>()
    const chats = [...pinnedChats, ...recentChats].filter((chat) => {
      if (seen.has(chat._id)) return false
      seen.add(chat._id)
      return true
    })
    return chats.slice(0, 60).map((chat) => ({
      id: chat._id,
      projectId: chat.projectId,
      title: chat.title,
      providerId: chat.providerId ?? "codex",
      providerInstanceId: chat.providerInstanceId ?? null,
      providerSessionId: chat.providerSessionId ?? chat.codexThreadId ?? null,
      status: chat.status,
      isUnread: chat.isUnread ?? false,
      isPinned: chat.isPinned ?? false,
      updatedAt: chat.updatedAt,
    }))
  },
})

/** Renames one saved chat without changing its transcript or recency. */
export const rename = mutation({
  args: { chatId: v.id("workspaceChats"), title: v.string() },
  handler: async (ctx, args) => {
    const title = boundedText(args.title, "Chat name", 64)
    const chat = await ctx.db.get(args.chatId)
    if (!chat) throw new Error("Chat not found")
    await ctx.db.patch(chat._id, { title })
  },
})

/** Sets the manual unread state for one saved chat. */
export const setUnread = mutation({
  args: { chatId: v.id("workspaceChats"), unread: v.boolean() },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    if (!chat) throw new Error("Chat not found")
    await ctx.db.patch(chat._id, { isUnread: args.unread })
  },
})

/** Sets whether one saved chat stays at the top of the history list. */
export const setPinned = mutation({
  args: { chatId: v.id("workspaceChats"), pinned: v.boolean() },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    if (!chat) throw new Error("Chat not found")
    await ctx.db.patch(chat._id, { isPinned: args.pinned })
  },
})

/** Loads one saved transcript and attachment metadata without returning source text. */
export const get = query({
  args: { chatId: v.id("workspaceChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat) return null
    const messages = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (index) => index.eq("chatId", chatId))
      .order("asc")
      .collect()
    const attachments = await ctx.db
      .query("workspaceChatAttachments")
      .withIndex("by_chat_createdAt", (index) => index.eq("chatId", chatId))
      .order("asc")
      .collect()
    return {
      id: chat._id,
      projectId: chat.projectId,
      title: chat.title,
      providerId: chat.providerId ?? "codex",
      providerInstanceId: chat.providerInstanceId ?? null,
      providerSessionId: chat.providerSessionId ?? chat.codexThreadId ?? null,
      status: chat.status,
      agentAutonomy: chat.agentAutonomy ?? "approval",
      agentInstructions: chat.agentInstructions ?? "",
      workingProjectId: chat.workingProjectId,
      lastError: chat.lastError ?? null,
      messages: messages.map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
        status: message.status,
        agentApproval: message.agentApproval,
        citations: message.citations ?? [],
        createdAt: message.createdAt,
      })),
      attachments: attachments.map((attachment) => ({
        id: attachment._id,
        documentId: attachment.documentId,
        kind: attachment.kind,
        label: attachment.label,
        ...(attachment.projectId ? { projectId: attachment.projectId } : {}),
        ...(attachment.itemId ? { itemId: attachment.itemId } : {}),
        url: attachment.url ?? null,
      })),
    }
  },
})

/** Marks a stranded assistant placeholder failed before accepting a new turn. */
async function recoverStaleTurn(
  ctx: Pick<MutationCtx, "db">,
  chat: Doc<"workspaceChats">,
  now: number
): Promise<void> {
  if (
    chat.status !== "running" ||
    !chat.activeMessageId ||
    chat.updatedAt > now - STALE_TURN_MS
  )
    return
  const active = await ctx.db.get(chat.activeMessageId)
  if (active && active.status === "running")
    await ctx.db.patch(active._id, {
      status: "failed",
      updatedAt: now,
    })
  await ctx.db.patch(chat._id, {
    status: "failed",
    activeMessageId: undefined,
    lastError: "The previous reply was interrupted.",
    updatedAt: now,
  })
}

/** Creates or resumes a chat and persists the user's message before Codex starts. */
export const startTurn = mutation({
  args: {
    chatId: v.optional(v.id("workspaceChats")),
    projectId: v.optional(v.id("projects")),
    continuationOf: v.optional(v.id("workspaceChatMessages")),
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerModel: v.optional(v.string()),
    providerEffort: v.optional(v.string()),
    clientMessageId: v.string(),
    message: v.string(),
    attachments: v.array(attachmentInput),
  },
  handler: async (ctx, args) => {
    const clientMessageId = boundedText(
      args.clientMessageId,
      "Client message ID",
      200
    )
    const message = boundedText(args.message, "Message", 4_000)
    if (args.attachments.length > 8) throw new Error("Attach at most 8 items")
    if (args.continuationOf && args.attachments.length)
      throw new Error("A continued response cannot add context")
    const cardAttachments = args.attachments.filter(
      (attachment) => attachment.kind === "card"
    )
    if (cardAttachments.length > 1)
      throw new Error("Attach one study card at a time")
    if (cardAttachments.length && args.chatId)
      throw new Error("Card chats must start a new chat")
    if (
      await ctx.db
        .query("workspaceChatMessages")
        .withIndex("by_clientMessageId", (index) =>
          index.eq("clientMessageId", clientMessageId)
        )
        .first()
    )
      throw new Error("This message was already sent")
    const now = Date.now()
    const requestedProvider = providerSelection(args.providerId)
    const requestedInstance = args.providerInstanceId
      ? boundedText(args.providerInstanceId, "Provider instance", 200)
      : undefined
    const requestedModel = args.providerModel
      ? boundedText(args.providerModel, "Provider model", 200)
      : undefined
    const requestedEffort = args.providerEffort
      ? boundedText(args.providerEffort, "Provider reasoning", 80)
      : undefined
    let chat: Doc<"workspaceChats"> | null = args.chatId
      ? await ctx.db.get(args.chatId)
      : null
    if (args.chatId && !chat) throw new Error("Chat not found")
    if (!chat && !args.projectId)
      throw new Error("Choose a project before starting a chat")
    if (chat?.projectId && args.projectId && chat.projectId !== args.projectId)
      throw new Error("Chat project cannot be changed")
    if (args.projectId && !(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    if (args.continuationOf && !chat)
      throw new Error("Continuing a response requires a chat")
    if (chat) await recoverStaleTurn(ctx, chat, now)
    if (chat) chat = await ctx.db.get(chat._id)
    const storedProvider = chat ? persistedChatProvider(chat) : undefined
    if (
      storedProvider &&
      requestedProvider !== undefined &&
      storedProvider !== requestedProvider
    )
      throw new Error("Start a new chat to change its provider")
    const selectedProvider = storedProvider ?? requestedProvider ?? "codex"
    if (chat?.codexThreadId && selectedProvider !== "codex")
      throw new Error(
        "This saved Codex chat cannot resume through another provider"
      )
    const selectedInstance = chat?.providerInstanceId ?? requestedInstance
    const selectedModel = chat?.providerModel ?? requestedModel
    const selectedEffort = chat?.providerEffort ?? requestedEffort
    if (chat?.status === "running")
      throw new Error("Wait for the active reply to finish")
    const priorMessages = chat
      ? await ctx.db
          .query("workspaceChatMessages")
          .withIndex("by_chat_createdAt", (index) =>
            index.eq("chatId", chat!._id)
          )
          .order("desc")
          .take(MAX_REPLAY_MESSAGES)
      : []
    const priorAttachments = chat
      ? await ctx.db
          .query("workspaceChatAttachments")
          .withIndex("by_chat_createdAt", (index) =>
            index.eq("chatId", chat!._id)
          )
          .order("desc")
          .take(MAX_REPLAY_ATTACHMENTS)
      : []
    const replayContext = replayAttachments(priorAttachments)
    if (args.continuationOf) {
      const continuation = await ctx.db.get(args.continuationOf)
      if (
        !chat ||
        !continuation ||
        continuation.chatId !== chat._id ||
        continuation.role !== "assistant" ||
        continuation.status !== "failed" ||
        priorMessages[0]?._id !== continuation._id
      )
        throw new Error("Only the latest interrupted response can continue")
      await ctx.db.patch(continuation._id, {
        status: "running",
        updatedAt: now,
      })
      await ctx.db.patch(chat._id, {
        status: "running",
        activeMessageId: continuation._id,
        ...(chat.providerId ? {} : { providerId: selectedProvider }),
        ...(chat.providerInstanceId || !selectedInstance
          ? {}
          : { providerInstanceId: selectedInstance }),
        ...(chat.providerModel || !selectedModel
          ? {}
          : { providerModel: selectedModel }),
        ...(chat.providerEffort || !selectedEffort
          ? {}
          : { providerEffort: selectedEffort }),
        lastError: undefined,
        updatedAt: now,
      })
      return {
        chatId: chat._id,
        assistantMessageId: continuation._id,
        providerId: selectedProvider,
        ...(selectedInstance ? { providerInstanceId: selectedInstance } : {}),
        ...(selectedModel ? { providerModel: selectedModel } : {}),
        ...(selectedEffort ? { providerEffort: selectedEffort } : {}),
        providerSessionId: chat.providerSessionId ?? chat.codexThreadId ?? null,
        codexThreadId: chat.codexThreadId ?? null,
        shouldReplayContext:
          !(chat.providerSessionId ?? chat.codexThreadId) ||
          chat.codexContextReady !== true,
        replyPrefix: continuation.content,
        replayContext: {
          messages: replayMessages(priorMessages),
          ...replayContext,
        },
      }
    }
    let chatId: Id<"workspaceChats">
    if (chat) chatId = chat._id
    else {
      chatId = await ctx.db.insert("workspaceChats", {
        projectId: args.projectId!,
        title: titleForMessage(message),
        isUnread: false,
        isPinned: false,
        status: "idle",
        providerId: selectedProvider,
        ...(selectedInstance ? { providerInstanceId: selectedInstance } : {}),
        ...(selectedModel ? { providerModel: selectedModel } : {}),
        ...(selectedEffort ? { providerEffort: selectedEffort } : {}),
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const attachment of args.attachments) {
      if (attachment.documentId) {
        const document = await ctx.db.get(attachment.documentId)
        if (
          !document ||
          document.projectId !== (chat?.projectId ?? args.projectId)
        )
          throw new Error("File does not belong to this chat's project")
        if (attachment.kind !== "file" && attachment.kind !== "link")
          throw new Error("Invalid file attachment")
      }
      const label = boundedText(attachment.label, "Attachment label", 255)
      const text = attachment.text?.trim() || undefined
      if (text && text.length > 48_000)
        throw new Error("Attachment is too large")
      if (attachment.kind === "project" && !attachment.projectId)
        throw new Error("Project attachment is invalid")
      if (attachment.kind === "card") {
        if (!attachment.projectId || !attachment.itemId)
          throw new Error("Card attachment is invalid")
        const item = await ctx.db.get(attachment.itemId)
        if (!item || item.projectId !== attachment.projectId)
          throw new Error("Card attachment does not belong to its project")
        if (!chat && attachment.projectId !== args.projectId)
          throw new Error("Card attachment does not belong to the chat project")
        if (text) throw new Error("Card attachment text is not allowed")
      }
      if (attachment.kind !== "project" && attachment.kind !== "card" && !text)
        throw new Error("Attachment text is required")
      await ctx.db.insert("workspaceChatAttachments", {
        ...(attachment.documentId ? { documentId: attachment.documentId } : {}),
        chatId,
        clientMessageId,
        kind: attachment.kind,
        label,
        ...(attachment.projectId ? { projectId: attachment.projectId } : {}),
        ...(attachment.itemId ? { itemId: attachment.itemId } : {}),
        ...(text ? { text } : {}),
        ...(attachment.url ? { url: attachment.url } : {}),
        createdAt: now,
      })
    }
    await ctx.db.insert("workspaceChatMessages", {
      chatId,
      clientMessageId,
      role: "user",
      content: message,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    })
    const assistantMessageId = await ctx.db.insert("workspaceChatMessages", {
      chatId,
      clientMessageId,
      role: "assistant",
      content: "",
      status: "running",
      createdAt: now + 1,
      updatedAt: now,
    })
    await ctx.db.patch(chatId, {
      status: "running",
      activeMessageId: assistantMessageId,
      ...(chat?.providerId ? {} : { providerId: selectedProvider }),
      ...(chat?.providerInstanceId || !selectedInstance
        ? {}
        : { providerInstanceId: selectedInstance }),
      ...(chat?.providerModel || !selectedModel
        ? {}
        : { providerModel: selectedModel }),
      ...(chat?.providerEffort || !selectedEffort
        ? {}
        : { providerEffort: selectedEffort }),
      lastError: undefined,
      updatedAt: now,
    })
    return {
      chatId,
      assistantMessageId,
      providerId: selectedProvider,
      ...(selectedInstance ? { providerInstanceId: selectedInstance } : {}),
      ...(selectedModel ? { providerModel: selectedModel } : {}),
      ...(selectedEffort ? { providerEffort: selectedEffort } : {}),
      providerSessionId: chat?.providerSessionId ?? chat?.codexThreadId ?? null,
      codexThreadId: chat?.codexThreadId ?? null,
      shouldReplayContext:
        Boolean(chat) &&
        (!(chat?.providerSessionId ?? chat?.codexThreadId) ||
          chat?.codexContextReady !== true),
      replyPrefix: "",
      replayContext: {
        messages: replayMessages(priorMessages),
        ...replayContext,
      },
    }
  },
})

/** Copies a stable transcript prefix into a new chat without altering the source chat. */
export const branch = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    includeMessage: v.boolean(),
    editedMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    const target = await ctx.db.get(args.messageId)
    if (!chat || !target || target.chatId !== chat._id)
      throw new Error("Chat message was not found")
    if (!chat.projectId)
      throw new Error(
        "This older chat needs a project before it can be branched"
      )
    if (chat.status === "running")
      throw new Error("Pause the active reply before branching")
    if (args.includeMessage && target.role !== "assistant")
      throw new Error("A response branch must end with an assistant message")
    if (!args.includeMessage && target.role !== "user")
      throw new Error("Only user messages can be edited")
    if (target.status === "running")
      throw new Error("Wait for the message to finish")
    const editedMessage = args.editedMessage
      ? boundedText(args.editedMessage, "Edited message", 4_000)
      : undefined
    if (!args.includeMessage && !editedMessage)
      throw new Error("Edited message is required")

    const sourceMessages = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (index) => index.eq("chatId", chat._id))
      .order("asc")
      .take(MAX_BRANCH_MESSAGES + 1)
    if (sourceMessages.length > MAX_BRANCH_MESSAGES)
      throw new Error("This chat is too long to branch")
    const targetIndex = sourceMessages.findIndex(
      (message) => message._id === target._id
    )
    if (targetIndex < 0) throw new Error("Chat message was not found")
    const selectedMessages = sourceMessages.slice(
      0,
      args.includeMessage ? targetIndex + 1 : targetIndex
    )
    const sourceAttachments = await ctx.db
      .query("workspaceChatAttachments")
      .withIndex("by_chat_createdAt", (index) => index.eq("chatId", chat._id))
      .order("asc")
      .take(MAX_BRANCH_ATTACHMENTS + 1)
    if (sourceAttachments.length > MAX_BRANCH_ATTACHMENTS)
      throw new Error("This chat has too much context to branch")

    const now = Date.now()
    const branchId = await ctx.db.insert("workspaceChats", {
      projectId: chat.projectId,
      title:
        !args.includeMessage && targetIndex === 0 && editedMessage
          ? titleForMessage(editedMessage)
          : titleForBranch(chat.title),
      isUnread: false,
      isPinned: false,
      branchedFromChatId: chat._id,
      branchedFromMessageId: target._id,
      ...(chat.providerId ? { providerId: chat.providerId } : {}),
      ...(chat.providerInstanceId
        ? { providerInstanceId: chat.providerInstanceId }
        : {}),
      ...(chat.providerModel ? { providerModel: chat.providerModel } : {}),
      ...(chat.providerEffort ? { providerEffort: chat.providerEffort } : {}),
      codexContextReady: false,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    })
    const clientMessageIds = new Map<string, string>()
    for (const [index, message] of selectedMessages.entries()) {
      const branchClientMessageId =
        clientMessageIds.get(message.clientMessageId) ??
        `branch:${branchId}:${clientMessageIds.size}`
      clientMessageIds.set(message.clientMessageId, branchClientMessageId)
      await ctx.db.insert("workspaceChatMessages", {
        chatId: branchId,
        clientMessageId: branchClientMessageId,
        role: message.role,
        content: message.content,
        ...(message.citations ? { citations: message.citations } : {}),
        status: message.status === "running" ? "failed" : message.status,
        createdAt: now + index,
        updatedAt: now,
      })
    }
    const editAttachmentClientMessageId = `branch:${branchId}:edit`
    for (const attachment of sourceAttachments) {
      const branchClientMessageId = clientMessageIds.get(
        attachment.clientMessageId
      )
      const belongsToEditedMessage =
        !args.includeMessage &&
        attachment.clientMessageId === target.clientMessageId
      if (!branchClientMessageId && !belongsToEditedMessage) continue
      await ctx.db.insert("workspaceChatAttachments", {
        ...(attachment.documentId ? { documentId: attachment.documentId } : {}),
        chatId: branchId,
        clientMessageId: branchClientMessageId ?? editAttachmentClientMessageId,
        kind: attachment.kind,
        label: attachment.label,
        ...(attachment.projectId ? { projectId: attachment.projectId } : {}),
        ...(attachment.itemId ? { itemId: attachment.itemId } : {}),
        ...(attachment.text ? { text: attachment.text } : {}),
        ...(attachment.url ? { url: attachment.url } : {}),
        createdAt: now,
      })
    }
    return { chatId: branchId }
  },
})

/** Persists accepted provider identifiers before streaming or completion can fail. */
export const bindTurn = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerTurnId: v.optional(v.string()),
    codexThreadId: v.optional(v.string()),
    codexTurnId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (!chat || !message || chat.activeMessageId !== message._id)
      throw new Error("Chat turn is no longer active")
    const storedProvider = persistedChatProvider(chat)
    const providerId =
      providerSelection(args.providerId) ?? storedProvider ?? "codex"
    if (storedProvider && providerId !== storedProvider)
      throw new Error("A chat turn cannot change its provider")
    const providerSessionId = boundedText(
      args.providerSessionId ?? args.codexThreadId ?? "",
      "Provider session ID",
      200
    )
    const providerTurnId = boundedText(
      args.providerTurnId ?? args.codexTurnId ?? "",
      "Provider turn ID",
      200
    )
    const now = Date.now()
    await ctx.db.patch(message._id, {
      providerTurnId,
      ...(args.codexTurnId
        ? { codexTurnId: boundedText(args.codexTurnId, "Codex turn ID", 200) }
        : {}),
      updatedAt: now,
    })
    await ctx.db.patch(chat._id, {
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
              "Codex thread ID",
              200
            ),
          }
        : {}),
      codexContextReady: true,
      updatedAt: now,
    })
  },
})

/** Saves a cumulative reply snapshot for the active assistant message. */
export const progress = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.reply.length > MAX_REPLY_LENGTH)
      throw new Error("Reply is too long")
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (
      !chat ||
      !message ||
      chat.activeMessageId !== message._id ||
      chat.status !== "running" ||
      message.status !== "running"
    )
      throw new Error("Chat turn is no longer active")
    if (args.reply.length < message.content.length) return
    const now = Date.now()
    await ctx.db.patch(message._id, { content: args.reply, updatedAt: now })
    await ctx.db.patch(chat._id, { updatedAt: now })
  },
})

/** Completes the active turn and stores the provider identifiers needed to resume it. */
export const complete = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerTurnId: v.optional(v.string()),
    codexThreadId: v.optional(v.string()),
    codexTurnId: v.optional(v.string()),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    const reply = boundedText(args.reply, "Reply", MAX_REPLY_LENGTH)
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (!chat || !message || chat.activeMessageId !== message._id)
      throw new Error("Chat turn is no longer active")
    const storedProvider = persistedChatProvider(chat)
    const providerId =
      providerSelection(args.providerId) ?? storedProvider ?? "codex"
    if (storedProvider && providerId !== storedProvider)
      throw new Error("A chat turn cannot change its provider")
    const providerSessionId = boundedText(
      args.providerSessionId ?? args.codexThreadId ?? "",
      "Provider session ID",
      200
    )
    const providerTurnId = boundedText(
      args.providerTurnId ?? args.codexTurnId ?? "",
      "Provider turn ID",
      200
    )
    const now = Date.now()
    await ctx.db.patch(message._id, {
      content: reply,
      status: "completed",
      providerTurnId,
      ...(args.codexTurnId
        ? { codexTurnId: boundedText(args.codexTurnId, "Codex turn ID", 200) }
        : {}),
      updatedAt: now,
    })
    await ctx.db.patch(chat._id, {
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
              "Codex thread ID",
              200
            ),
          }
        : {}),
      codexContextReady: true,
      status: "idle",
      activeMessageId: undefined,
      lastError: undefined,
      updatedAt: now,
    })
  },
})

/** Marks the active assistant message failed while retaining any streamed text. */
export const fail = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const error = boundedText(args.error, "Chat error", 500)
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (!chat || !message || chat.activeMessageId !== message._id) return
    const now = Date.now()
    await ctx.db.patch(message._id, { status: "failed", updatedAt: now })
    await ctx.db.patch(chat._id, {
      status: "failed",
      activeMessageId: undefined,
      lastError: error,
      updatedAt: now,
    })
  },
})
