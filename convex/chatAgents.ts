/** Persists chat-scoped agent settings and approval state for assistant turns. */
import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"

const autonomy = v.union(
  v.literal("approval"),
  v.literal("project"),
  v.literal("full")
)
/** Current app-owned provider tool set; changing it refreshes legacy sessions once. */
const AGENT_REQUEST_TOOLS_VERSION = 1
const approvalInput = v.object({
  id: v.string(),
  providerRequestId: v.optional(v.string()),
  method: v.string(),
  kind: v.optional(
    v.union(
      v.literal("approval"),
      v.literal("question"),
      v.literal("form"),
      v.literal("url")
    )
  ),
  title: v.optional(v.string()),
  prompt: v.optional(v.string()),
  input: v.optional(v.string()),
  details: v.string(),
  expiresAt: v.number(),
})

/** Copies one interaction into the bounded per-message request history. */
function historyEntry(
  approval: {
    id: string
    providerRequestId?: string
    method: string
    kind?: "approval" | "question" | "form" | "url"
    title?: string
    prompt?: string
    input?: string
    details: string
    expiresAt: number
  },
  status: "pending" | "approved" | "denied" | "expired" | "cancelled",
  response?: string,
  completedAt?: number
) {
  return {
    ...approval,
    ...(approval.providerRequestId
      ? { providerRequestId: approval.providerRequestId }
      : {}),
    kind: approval.kind ?? "approval",
    status,
    ...(response === undefined ? {} : { response }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

/** Removes secret question and form values before retaining completed history. */
function safeHistoryResponse(input: string | undefined, response: string | undefined): string | undefined {
  if (!response) return response
  if (!input) return response
  try {
    const controls = JSON.parse(input) as {
      questions?: Array<{ id?: string; isSecret?: boolean }>
      fields?: Array<{ id?: string; secret?: boolean }>
    }
    const value = JSON.parse(response) as Record<string, unknown>
    const secretQuestions = new Set(
      (controls.questions ?? []).filter((q) => q.isSecret && q.id).map((q) => q.id!)
    )
    const secretFields = new Set(
      (controls.fields ?? []).filter((f) => f.secret && f.id).map((f) => f.id!)
    )
    const answers = value.answers as Record<string, unknown> | undefined
    if (answers) for (const id of secretQuestions) delete answers[id]
    const content = value.content as Record<string, unknown> | undefined
    if (content) for (const id of secretFields) delete content[id]
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Validates the bounded request payload and its short-lived expiry. */
function validateApproval(
  approval: {
    id: string
    method: string
    kind?: "approval" | "question" | "form" | "url"
    title?: string
    prompt?: string
    input?: string
    details: string
    expiresAt: number
  },
  now: number
): void {
  if (
    !approval.id ||
    approval.id.length > 200 ||
    !approval.method ||
    approval.method.length > 200 ||
    (approval.title !== undefined && approval.title.length > 200) ||
    (approval.prompt !== undefined && approval.prompt.length > 4_000) ||
    (approval.input !== undefined && approval.input.length > 20_000) ||
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

/** Returns whether an approval grants provider access rather than confirming a user-requested step. */
function requiresApprovalAutonomy(approval: {
  kind?: "approval" | "question" | "form" | "url"
  method: string
}): boolean {
  return (
    (approval.kind ?? "approval") === "approval" &&
    approval.method !== "item/tool/call"
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
      previous.projectId !== args.workingProjectId ||
      chat.agentRequestToolsVersion !== AGENT_REQUEST_TOOLS_VERSION
    await ctx.db.patch(args.chatId, {
      agentAutonomy: args.autonomy,
      agentInstructions: instructions,
      workingProjectId: args.workingProjectId,
      agentRequestToolsVersion: AGENT_REQUEST_TOOLS_VERSION,
    })
    return { resetContext }
  },
})

/** Stores one pending provider request on the active assistant turn. */
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
    if (!isActiveMessage(chat, message))
      throw new Error("Chat cannot request an agent interaction")
    validateApproval(args.approval, now)
    if (
      requiresApprovalAutonomy(args.approval) &&
      (chat.agentAutonomy ?? "approval") !== "approval"
    )
      throw new Error("Chat cannot request approval")
    if (message.agentApproval?.status === "pending")
      throw new Error("An agent request is already pending")
    const approval = {
      ...args.approval,
      kind: args.approval.kind ?? "approval",
      status: "pending" as const,
    }
    const history = [
      ...(message.agentRequests ?? []),
      historyEntry(args.approval, "pending"),
    ].slice(-20)
    await ctx.db.patch(args.messageId, {
      agentApproval: approval,
      agentRequests: history,
      updatedAt: now,
    })
    return approval
  },
})

/** Resolves a pending provider request while the associated assistant turn remains active. */
export const decideApproval = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    response: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chat = await chatFor(ctx, args.chatId)
    const message = await messageFor(ctx, args.chatId, args.messageId)
    const approval = message.agentApproval
    if (!isActiveMessage(chat, message) || !approval)
      throw new Error("Agent request is no longer available")
    if (
      requiresApprovalAutonomy(approval) &&
      (chat.agentAutonomy ?? "approval") !== "approval"
    )
      throw new Error("Approval is no longer available")
    if (
      approval.id !== args.approvalId ||
      approval.status !== "pending" ||
      approval.expiresAt <= Date.now() ||
      (args.response !== undefined && args.response.length > 20_000)
    )
      throw new Error("Agent request is no longer available")
    const updated = {
      ...approval,
      status: args.decision,
      ...(args.response === undefined ? {} : { response: args.response }),
    }
    const history = (message.agentRequests ?? []).map((entry) =>
      entry.id === approval.id
        ? {
            ...entry,
            status: args.decision,
            ...(args.response === undefined
              ? {}
              : { response: safeHistoryResponse(approval.input, args.response) }),
            completedAt: Date.now(),
          }
        : entry
    )
    await ctx.db.patch(args.messageId, {
      agentApproval: updated,
      agentRequests: history,
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
    approvalId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await chatFor(ctx, args.chatId)
    await messageFor(ctx, args.chatId, args.messageId)
    const message = await ctx.db.get(args.messageId)
    if (!message) return
    if (
      args.approvalId !== undefined &&
      message.agentApproval?.id !== args.approvalId
    )
      return
    const now = Date.now()
    const current = message.agentApproval
    const history = (message.agentRequests ?? []).map((entry) =>
      current && entry.id === current.id && entry.status === "pending"
        ? {
            ...entry,
            status: current.expiresAt <= now ? ("expired" as const) : ("cancelled" as const),
            completedAt: now,
          }
        : entry
    )
    await ctx.db.patch(args.messageId, {
      agentApproval: current
        ? {
            ...current,
            ...(current.response === undefined
              ? {}
              : { response: safeHistoryResponse(current.input, current.response) }),
            ...(current.status === "pending"
              ? {
                  status:
                    current.expiresAt <= now
                      ? ("expired" as const)
                      : ("cancelled" as const),
                }
              : {}),
          }
        : undefined,
      agentRequests: history,
      updatedAt: now,
    })
  },
})
