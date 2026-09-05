/** Persists chat-scoped agent settings and approval state for assistant turns. */
import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"

const autonomy = v.union(
  v.literal("approval"),
  v.literal("project"),
  v.literal("full")
)
const approvalInput = v.object({
  id: v.string(),
  method: v.string(),
  details: v.string(),
  expiresAt: v.number(),
})

/** Validates the bounded approval payload and its short-lived expiry. */
function validateApproval(
  approval: { id: string; method: string; details: string; expiresAt: number },
  now: number
): void {
  if (
    !approval.id ||
    approval.id.length > 200 ||
    !approval.method ||
    approval.method.length > 200 ||
    approval.details.length > 20_000 ||
    !Number.isFinite(approval.expiresAt) ||
    approval.expiresAt <= now ||
    approval.expiresAt > now + 5 * 60 * 1000
  )
    throw new Error("Approval request is invalid")
}

/** Loads a chat and rejects unknown chat IDs. */
async function chatFor(
  ctx: Pick<QueryCtx, "db">,
  chatId: Id<"workspaceChats">
) {
  const chat = await ctx.db.get(chatId)
  if (!chat) throw new Error("Chat not found")
  return chat
}

/** Loads a message and verifies that it belongs to the requested chat. */
async function messageFor(
  ctx: Pick<QueryCtx, "db">,
  chatId: Id<"workspaceChats">,
  messageId: Id<"workspaceChatMessages">
) {
  const message = await ctx.db.get(messageId)
  if (!message || message.chatId !== chatId)
    throw new Error("Chat message not found")
  return message
}

/** Returns whether an assistant message is the currently running chat turn. */
function isActiveMessage(
  chat: { status: string; activeMessageId?: Id<"workspaceChatMessages"> },
  message: { _id: Id<"workspaceChatMessages">; role: string; status: string }
): boolean {
  return (
    chat.status === "running" &&
    chat.activeMessageId === message._id &&
    message.role === "assistant" &&
    message.status === "running"
  )
}

/** Reads chat agent settings, applying the safe defaults for legacy chats. */
export const getSettings = query({
  args: { chatId: v.id("workspaceChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await chatFor(ctx, chatId)
    return {
      chatId,
      autonomy: chat.agentAutonomy ?? "approval",
      additionalInstructions: chat.agentInstructions ?? "",
      workingProjectId: chat.workingProjectId,
    }
  },
})

/** Saves chat agent settings and reports whether the Codex context must be reset. */
export const configure = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    autonomy,
    additionalInstructions: v.string(),
    workingProjectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const chat = await chatFor(ctx, args.chatId)
    const instructions = args.additionalInstructions.trim()
    if (instructions.length > 4_000)
      throw new Error("Agent instructions are too long")
    if (
      args.workingProjectId !== undefined &&
      !(await ctx.db.get(args.workingProjectId))
    )
      throw new Error("Project not found")
    const previous = {
      autonomy: chat.agentAutonomy ?? "approval",
      instructions: chat.agentInstructions ?? "",
      projectId: chat.workingProjectId,
    }
    const resetContext =
      previous.autonomy !== args.autonomy ||
      previous.instructions !== instructions ||
      previous.projectId !== args.workingProjectId
    await ctx.db.patch(args.chatId, {
      agentAutonomy: args.autonomy,
      agentInstructions: instructions,
      workingProjectId: args.workingProjectId,
    })
    return { resetContext }
  },
})

/** Stores one pending approval on the active assistant turn under approval autonomy. */
export const requestApproval = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    approval: approvalInput,
  },
  handler: async (ctx, args) => {
    const chat = await chatFor(ctx, args.chatId)
    const message = await messageFor(ctx, args.chatId, args.messageId)
    const now = Date.now()
    if (
      !isActiveMessage(chat, message) ||
      (chat.agentAutonomy ?? "approval") !== "approval"
    )
      throw new Error("Chat cannot request approval")
    validateApproval(args.approval, now)
    if (message.agentApproval?.status === "pending")
      throw new Error("An approval is already pending")
    const approval = { ...args.approval, status: "pending" as const }
    await ctx.db.patch(args.messageId, {
      agentApproval: approval,
      updatedAt: now,
    })
    return approval
  },
})

/** Decides a pending approval while the associated assistant turn remains active. */
export const decideApproval = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
  },
  handler: async (ctx, args) => {
    const chat = await chatFor(ctx, args.chatId)
    const message = await messageFor(ctx, args.chatId, args.messageId)
    const approval = message.agentApproval
    if (
      !isActiveMessage(chat, message) ||
      (chat.agentAutonomy ?? "approval") !== "approval" ||
      !approval ||
      approval.id !== args.approvalId ||
      approval.status !== "pending" ||
      approval.expiresAt <= Date.now()
    )
      throw new Error("Approval is no longer available")
    const updated = { ...approval, status: args.decision }
    await ctx.db.patch(args.messageId, {
      agentApproval: updated,
      updatedAt: Date.now(),
    })
    return { success: true, approval: updated }
  },
})

/** Returns approval state and whether it is still attached to the active assistant turn. */
export const getApproval = query({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
  },
  handler: async (ctx, args) => {
    const chat = await chatFor(ctx, args.chatId)
    const message = await messageFor(ctx, args.chatId, args.messageId)
    const approval = message.agentApproval
    return {
      approval,
      active: Boolean(
        approval &&
        isActiveMessage(chat, message) &&
        approval.expiresAt > Date.now()
      ),
    }
  },
})

/** Clears approval state after a turn finishes or is cancelled. */
export const clearApproval = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
  },
  handler: async (ctx, args) => {
    await chatFor(ctx, args.chatId)
    await messageFor(ctx, args.chatId, args.messageId)
    await ctx.db.patch(args.messageId, {
      agentApproval: undefined,
      updatedAt: Date.now(),
    })
  },
})
