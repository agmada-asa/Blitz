/**
 * Reads saved legacy card conversations so older chat links keep opening.
 *
 * The card chat worker that answered queued questions has been removed, and no
 * function here writes new questions. Web asks about cards in workspace chat.
 */

import { query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { isAiProviderId } from "../lib/ai-model-settings"

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
