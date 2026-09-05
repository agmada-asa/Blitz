/** Persists bounded, project-scoped written practice with source snapshots. */

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { applyWrittenAnswer } from "../lib/learning/writing"

/** Public item returned to clients; unrevealed references are deliberately absent. */
export type WritingActivityItem = {
  itemId: Id<"learningItems">
  title: string
  prompt: string
  sourceLabels: string[]
  answer?: string
  revealed: boolean
  reference?: string
}

/** Public persisted written-practice activity contract. */
export type WritingActivity = {
  _id: Id<"writingActivities">
  projectId: Id<"projects">
  topicId?: Id<"topics">
  status: "active" | "completed"
  items: WritingActivityItem[]
  createdAt: number
  updatedAt: number
}

/** Internal snapshot shape retaining a hidden source reference in storage. */
type StoredWritingItem = WritingActivityItem & { reference: string }

const MAX_ITEMS = 5
const ITEM_PAGE_SIZE = 100
const MAX_SCAN_PAGES = 20

/** Trims and bounds user supplied text. */
function boundedText(value: string, label: string, maximum: number): string {
  const result = value.trim()
  if (!result) throw new Error(`${label} is required`)
  if (result.length > maximum) throw new Error(`${label} is too long`)
  return result
}

/** Confirms that a project and optional topic exist under the requested scope. */
async function validateScope(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  topicId: Id<"topics"> | undefined
): Promise<void> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
  if (topicId) {
    const topic = await ctx.db.get(topicId)
    if (!topic || topic.projectId !== projectId)
      throw new Error("Topic does not belong to project")
  }
}

/** Returns the latest activity in a scope, using a bounded scan. */
async function latestInScope(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  topicId: Id<"topics"> | undefined
): Promise<Doc<"writingActivities"> | null> {
  return ctx.db
    .query("writingActivities")
    .withIndex("by_project_topic_createdAt", (q) =>
      q.eq("projectId", projectId).eq("topicId", topicId)
    )
    .order("desc")
    .first()
}

/** Removes hidden reference text from an activity response. */
function present(activity: Doc<"writingActivities">): WritingActivity {
  return {
    _id: activity._id,
    projectId: activity.projectId,
    ...(activity.topicId ? { topicId: activity.topicId } : {}),
    status: activity.status,
    items: activity.items.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      prompt: item.prompt,
      sourceLabels: item.sourceLabels,
      ...(item.answer !== undefined ? { answer: item.answer } : {}),
      revealed: item.revealed,
      ...(item.revealed ? { reference: item.reference } : {}),
    })),
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
  }
}

/** Finds a persisted activity by request id for retry-safe starts. */
async function byRequest(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  requestId: string
): Promise<Doc<"writingActivities"> | null> {
  return ctx.db
    .query("writingActivities")
    .withIndex("by_project_requestId", (q) =>
      q.eq("projectId", projectId).eq("requestId", requestId)
    )
    .first()
}

/** Builds up to five immutable explain-item snapshots for a scope. */
async function collectPrompts(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  topicId: Id<"topics"> | undefined,
  afterCreationTime?: number
): Promise<StoredWritingItem[]> {
  const result: StoredWritingItem[] = []
  let anchor = afterCreationTime
  let reachedEnd = false
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
    const candidates = await ctx.db
      .query("learningItems")
      .withIndex("by_project", (q) =>
        anchor === undefined
          ? q.eq("projectId", projectId)
          : q.eq("projectId", projectId).gt("_creationTime", anchor)
      )
      .order("asc")
      .take(ITEM_PAGE_SIZE)
    for (const item of candidates) {
      if (item.type !== "explain") continue
      const concept = await ctx.db.get(item.conceptId)
      if (
        !concept ||
        concept.projectId !== projectId ||
        (topicId !== undefined && concept.topicId !== topicId)
      )
        continue
      if (!item.body.trim()) continue
      const labels: string[] = []
      for (const sourceId of item.sourceIds.slice(0, 8)) {
        const source = await ctx.db.get(sourceId)
        if (source && source.projectId === projectId)
          labels.push(source.filename)
      }
      if (!labels.length) continue
      result.push({
        itemId: item._id,
        title: item.title,
        prompt: `Explain ${item.title} in your own words.`,
        sourceLabels: labels,
        reference: item.body,
        revealed: false,
      })
      if (result.length === MAX_ITEMS) return result
    }
    if (candidates.length < ITEM_PAGE_SIZE) {
      reachedEnd = true
      break
    }
    anchor = candidates.at(-1)!._creationTime
  }
  // A short final activity finishes the remaining material before the next
  // activity wraps. Reaching the scan budget never pretends to reach the end.
  if (!result.length && reachedEnd && afterCreationTime !== undefined)
    return collectPrompts(ctx, projectId, topicId)
  if (!result.length) {
    if (!reachedEnd)
      throw new Error(
        "Written practice scan limit reached. Choose a different topic."
      )
  }
  return result
}

/** Returns the latest written activity without exposing hidden references. */
export const getLatest = query({
  args: { projectId: v.id("projects"), topicId: v.optional(v.id("topics")) },
  handler: async (ctx, args) => {
    await validateScope(ctx, args.projectId, args.topicId)
    const activity = await latestInScope(ctx, args.projectId, args.topicId)
    return activity ? present(activity) : null
  },
})

/** Starts an activity, resuming the latest active one and idempotently reusing requests. */
export const start = mutation({
  args: {
    projectId: v.id("projects"),
    topicId: v.optional(v.id("topics")),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    await validateScope(ctx, args.projectId, args.topicId)
    const requestId = boundedText(args.requestId, "Request ID", 200)
    const existingRequest = await byRequest(ctx, args.projectId, requestId)
    if (existingRequest) {
      if (existingRequest.topicId !== args.topicId)
        throw new Error("Request ID was used for a different activity scope")
      return present(existingRequest)
    }
    const latest = await latestInScope(ctx, args.projectId, args.topicId)
    if (latest?.status === "active") return present(latest)
    const now = Date.now()
    const previousCreationTime = latest?.items.at(-1)
      ? (await ctx.db.get(latest.items.at(-1)!.itemId))?._creationTime
      : undefined
    const items = await collectPrompts(
      ctx,
      args.projectId,
      args.topicId,
      previousCreationTime
    )
    // An empty topic is a normal result, not a failed operation or an empty
    // persisted activity. The interface can offer another project or topic.
    if (!items.length) return null
    const id = await ctx.db.insert("writingActivities", {
      projectId: args.projectId,
      ...(args.topicId ? { topicId: args.topicId } : {}),
      requestId,
      status: "active",
      items,
      createdAt: now,
      updatedAt: now,
    })
    const activity = await ctx.db.get(id)
    if (!activity) throw new Error("Written activity could not be created")
    return present(activity)
  },
})

/** Saves a draft or permanently reveals one answer and its source reference. */
export const saveAnswer = mutation({
  args: {
    projectId: v.id("projects"),
    activityId: v.id("writingActivities"),
    itemId: v.id("learningItems"),
    answer: v.string(),
    reveal: v.boolean(),
  },
  handler: async (ctx: MutationCtx, args) => {
    const activity = await ctx.db.get(args.activityId)
    if (!activity || activity.projectId !== args.projectId)
      throw new Error("Written activity does not belong to project")
    const answer = boundedText(args.answer, "Answer", 10_000)
    const index = activity.items.findIndex(
      (item) => item.itemId === args.itemId
    )
    if (index < 0) throw new Error("Item does not belong to written activity")
    const current = activity.items[index]
    const item = await ctx.db.get(args.itemId)
    if (!item || item.projectId !== args.projectId || item.type !== "explain")
      throw new Error("Written item is no longer available")
    const next = applyWrittenAnswer(current, answer, args.reveal)
    const updatedItem = { ...current, ...next }
    const items = activity.items.map((candidate, candidateIndex) =>
      candidateIndex === index ? updatedItem : candidate
    )
    const updated = {
      items,
      status: items.every((candidate) => candidate.revealed)
        ? ("completed" as const)
        : activity.status,
      updatedAt: Date.now(),
    }
    await ctx.db.patch(activity._id, updated)
    const result = await ctx.db.get(activity._id)
    if (!result) throw new Error("Written activity could not be saved")
    return present(result)
  },
})
