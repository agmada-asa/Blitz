/**
 * Runs a lesson update through its stages: claim the lesson, hand the server
 * what the analysis needs, then merge the result or record why it failed.
 *
 * Only the Teach session's bookkeeping changes here. Messages, quiz answers,
 * the side chat and progress already earned are never touched, so an update
 * cannot lose anything the learner has done. The rules live in
 * `lib/teach-updates.ts`; the model call in `lib/server/teach-update.ts`.
 */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import {
  isTeachUpdateRunning,
  MAX_TEACH_UPDATE_RECORDS,
  mergeTeachUpdate,
  teachNewSources,
} from "../lib/teach-updates"

/** Most new sources read into one analysis. */
const MAX_UPDATE_SOURCES = 40

/** Characters of each new source passed to the analysis. */
const MAX_UPDATE_SOURCE_TEXT = 200_000

/** The analysis fields merged into a lesson. */
const updateReplyValidator = v.object({
  summary: v.string(),
  sections: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      concepts: v.array(v.string()),
      change: v.union(v.literal("unchanged"), v.literal("updated"), v.literal("added")),
      note: v.string(),
    })
  ),
})

/** Returns the unit's current Teach session, if it has not been archived. */
async function activeTeachChat(
  ctx: Pick<QueryCtx, "db">,
  unitId: Id<"units">
): Promise<Doc<"workspaceChats"> | null> {
  const chat = await ctx.db
    .query("workspaceChats")
    .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unitId))
    .order("desc")
    .first()
  return chat && chat.purpose === "teach" && !chat.isArchived ? chat : null
}

/** Reads the unit's sources, the fuller records for prompts and the shared shape for rules. */
async function unitSources(ctx: Pick<QueryCtx, "db">, unitId: Id<"units">) {
  const sources = await ctx.db
    .query("sources")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect()
  return sources.map((source) => ({
    source,
    id: source._id as string,
    filename: source.filename,
    status: source.status,
    hasText: source.extractedText.trim().length > 0,
    unsupported: source.unsupported ?? false,
    createdAt: source.createdAt,
  }))
}

/**
 * Claims a unit's lesson for an update, so no turn starts while the outline is
 * being revised.
 *
 * @returns `started` with the run to perform, or why nothing started:
 *   `no-lesson` (no outline yet, so a first turn will see every file),
 *   `up-to-date`, `running` (an update is already under way) or
 *   `busy` (a reply is being written).
 */
export const begin = mutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const chat = await activeTeachChat(ctx, unitId)
    if (!chat?.teachOutline) return { status: "no-lesson" as const }
    const now = Date.now()
    if (isTeachUpdateRunning(chat.teachUpdateRun, now)) return { status: "running" as const }
    if (chat.status === "running") return { status: "busy" as const }
    // A run only claims what its analysis will read, because a finished run
    // marks its files as covered. Any beyond the limit stay new for the next one.
    const sources = teachNewSources(
      chat.teachCoveredSourceIds,
      chat.createdAt,
      await unitSources(ctx, unitId)
    ).slice(0, MAX_UPDATE_SOURCES)
    if (!sources.length) return { status: "up-to-date" as const }
    const token = crypto.randomUUID()
    const sourceIds = sources.map(({ source }) => source._id)
    await ctx.db.patch(chat._id, {
      teachUpdateRun: { status: "running", token, startedAt: now, sourceIds },
    })
    return { status: "started" as const, chatId: chat._id, token }
  },
})

/**
 * Supplies the server with one update's inputs. The new files' text is bounded
 * and the older files are named only, so no more material leaves than is needed.
 */
export const runContext = query({
  args: { chatId: v.id("workspaceChats"), token: v.string() },
  handler: async (ctx, { chatId, token }) => {
    const chat = await ctx.db.get(chatId)
    const run = chat?.teachUpdateRun
    if (!chat?.teachOutline || !chat.unitId || run?.token !== token) return null
    const unit = await ctx.db.get(chat.unitId)
    const project = unit ? await ctx.db.get(unit.projectId) : null
    if (!unit || !project) return null
    const newIds = new Set<string>(run.sourceIds)
    const all = await unitSources(ctx, chat.unitId)
    return {
      moduleTitle: project.title,
      unitId: chat.unitId,
      unitTitle: unit.title,
      outline: chat.teachOutline,
      taughtSectionIds: chat.teachTaughtSectionIds ?? [],
      existingFilenames: all
        .filter((entry) => !newIds.has(entry.id) && entry.hasText)
        .map((entry) => entry.filename),
      newSources: all
        .filter((entry) => newIds.has(entry.id))
        .map(({ source }) => ({
          filename: source.filename,
          text: source.extractedText.slice(0, MAX_UPDATE_SOURCE_TEXT),
        })),
    }
  },
})

/**
 * Merges a finished analysis into the lesson and clears the run. The live
 * session is told on its next turn, through the unsent fields.
 *
 * @returns False when this run no longer holds the lesson, so nothing was changed.
 */
export const apply = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    token: v.string(),
    reply: updateReplyValidator,
  },
  handler: async (ctx, { chatId, token, reply }) => {
    const chat = await ctx.db.get(chatId)
    const run = chat?.teachUpdateRun
    if (!chat?.teachOutline || run?.status !== "running" || run.token !== token) return false
    const updates = chat.teachUpdates ?? []
    const result = mergeTeachUpdate(
      {
        outline: chat.teachOutline,
        ...(chat.teachSectionPlan ? { plan: chat.teachSectionPlan } : {}),
        sectionIndex: chat.teachSectionIndex ?? 0,
        taughtSectionIds: chat.teachTaughtSectionIds ?? [],
        pending: chat.teachPendingSections ?? [],
        updateCount: updates.length,
      },
      reply
    )
    const covered = new Set<Id<"sources">>(chat.teachCoveredSourceIds ?? [])
    const filenames: string[] = []
    // A legacy session records its older files too, so they are not offered again.
    if (!chat.teachCoveredSourceIds && chat.unitId)
      for (const { source } of await unitSources(ctx, chat.unitId))
        if (source.createdAt <= chat.createdAt) covered.add(source._id)
    for (const sourceId of run.sourceIds) {
      covered.add(sourceId)
      const source = await ctx.db.get(sourceId)
      if (source) filenames.push(source.filename)
    }
    await ctx.db.patch(chat._id, {
      teachOutline: result.outline,
      ...(result.plan ? { teachSectionPlan: result.plan } : {}),
      teachSectionIndex: result.sectionIndex,
      teachPendingSections: result.pending,
      teachUpdates: [
        ...updates,
        { at: Date.now(), filenames, summary: reply.summary, sections: result.sections },
      ].slice(-MAX_TEACH_UPDATE_RECORDS),
      teachCoveredSourceIds: [...covered],
      teachUnsentSourceIds: [...(chat.teachUnsentSourceIds ?? []), ...run.sourceIds],
      teachUnsentSummaries: [...(chat.teachUnsentSummaries ?? []), reply.summary],
      teachUpdateRun: undefined,
    })
    return true
  },
})

/** Records why an update failed, leaving the lesson exactly as it was. */
export const fail = mutation({
  args: { chatId: v.id("workspaceChats"), token: v.string(), error: v.string() },
  handler: async (ctx, { chatId, token, error }) => {
    const chat = await ctx.db.get(chatId)
    const run = chat?.teachUpdateRun
    if (!chat || run?.status !== "running" || run.token !== token) return
    await ctx.db.patch(chat._id, {
      teachUpdateRun: { ...run, status: "failed", error: error.slice(0, 300) },
    })
  },
})
