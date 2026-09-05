/** Persists general Codex chats, messages, attachments, and streaming progress. */

import { mutation, query, type MutationCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"

/** Maximum idle time before a stranded running turn can be replaced. */
const STALE_TURN_MS = 2 * 60 * 1_000
/** Maximum assistant reply retained for one persisted message. */
const MAX_REPLY_LENGTH = 250_000

/** Validator shared by file, link, and project context records. */
const attachmentInput = v.object({
  kind: v.union(v.literal("project"), v.literal("file"), v.literal("link")),
  label: v.string(),
  projectId: v.optional(v.id("projects")),
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

/** Returns chat summaries in most-recently-active order for the history sidebar. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chats = await ctx.db
      .query("workspaceChats")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(60)
    return chats.map((chat) => ({
      id: chat._id,
      title: chat.title,
      status: chat.status,
      updatedAt: chat.updatedAt,
    }))
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
      title: chat.title,
      status: chat.status,
      lastError: chat.lastError ?? null,
      messages: messages.map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
      })),
      attachments: attachments.map((attachment) => ({
        id: attachment._id,
        kind: attachment.kind,
        label: attachment.label,
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
    let chat: Doc<"workspaceChats"> | null = args.chatId
      ? await ctx.db.get(args.chatId)
      : null
    if (args.chatId && !chat) throw new Error("Chat not found")
    if (chat) await recoverStaleTurn(ctx, chat, now)
    if (chat) chat = await ctx.db.get(chat._id)
    if (chat?.status === "running")
      throw new Error("Wait for the active reply to finish")
    let chatId: Id<"workspaceChats">
    if (chat) chatId = chat._id
    else {
      chatId = await ctx.db.insert("workspaceChats", {
        title: titleForMessage(message),
        status: "idle",
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const attachment of args.attachments) {
      const label = boundedText(attachment.label, "Attachment label", 255)
      const text = attachment.text?.trim() || undefined
      if (text && text.length > 48_000)
        throw new Error("Attachment is too large")
      if (attachment.kind === "project" && !attachment.projectId)
        throw new Error("Project attachment is invalid")
      if (attachment.kind !== "project" && !text)
        throw new Error("Attachment text is required")
      await ctx.db.insert("workspaceChatAttachments", {
        chatId,
        clientMessageId,
        kind: attachment.kind,
        label,
        ...(attachment.projectId ? { projectId: attachment.projectId } : {}),
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
      lastError: undefined,
      updatedAt: now,
    })
    return {
      chatId,
      assistantMessageId,
      codexThreadId: chat?.codexThreadId ?? null,
    }
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

/** Completes the active turn and stores the Codex identifiers needed to resume it. */
export const complete = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    codexThreadId: v.string(),
    codexTurnId: v.string(),
    reply: v.string(),
  },
  handler: async (ctx, args) => {
    const reply = boundedText(args.reply, "Reply", MAX_REPLY_LENGTH)
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (!chat || !message || chat.activeMessageId !== message._id)
      throw new Error("Chat turn is no longer active")
    const now = Date.now()
    await ctx.db.patch(message._id, {
      content: reply,
      status: "completed",
      codexTurnId: boundedText(args.codexTurnId, "Codex turn ID", 200),
      updatedAt: now,
    })
    await ctx.db.patch(chat._id, {
      codexThreadId: boundedText(args.codexThreadId, "Codex thread ID", 200),
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
