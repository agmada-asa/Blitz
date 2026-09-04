/** Provides project-owned topic reads and reversible topic organization edits. */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"

/** Maximum length for a user-edited topic title. */
export const MAX_TOPIC_TITLE_LENGTH = 140

/** Read-only database context used by the ownership helpers. */
type TopicReadContext = Pick<QueryCtx, "db">

/** Confirms that both project and topic exist and belong together. */
async function requireProjectTopic(
  ctx: TopicReadContext,
  projectId: Id<"projects">,
  topicId: Id<"topics">
) {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
  const topic = await ctx.db.get(topicId)
  if (!topic) throw new Error("Topic not found")
  if (topic.projectId !== projectId)
    throw new Error("Topic does not belong to project")
  return topic
}

/** Trims, collapses, and bounds a user-edited topic title. */
function normalizeTopicTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error("Topic title is required")
  if (normalized.length > MAX_TOPIC_TITLE_LENGTH)
    throw new Error("Topic title is too long")
  return normalized
}

/** Lists all generated topics for one project in title order. */
export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const topics = await ctx.db
      .query("topics")
      .withIndex("by_project_title", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .collect()

    return topics.map((topic) => ({
      _id: topic._id,
      title: topic.title,
      parentTopicId: topic.parentTopicId,
      createdAt: topic.createdAt,
      excludedFromFeed: topic.excludedFromFeed ?? false,
    }))
  },
})

/** Renames a project topic while preventing case-insensitive duplicates. */
export const rename = mutation({
  args: {
    projectId: v.id("projects"),
    topicId: v.id("topics"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const topic = await requireProjectTopic(ctx, args.projectId, args.topicId)
    const title = normalizeTopicTitle(args.title)
    const siblings = await ctx.db
      .query("topics")
      .withIndex("by_project", (q) => q.eq("projectId", topic.projectId))
      .collect()
    const duplicate = siblings.some(
      (candidate) =>
        candidate._id !== topic._id &&
        candidate.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase()
    )
    if (duplicate) throw new Error("A topic with that name already exists")
    await ctx.db.patch(topic._id, { title })
    return topic._id
  },
})

/** Includes or excludes one project topic from the unfiltered home feed. */
export const setFeedInclusion = mutation({
  args: {
    projectId: v.id("projects"),
    topicId: v.id("topics"),
    included: v.boolean(),
  },
  handler: async (ctx, args) => {
    const topic = await requireProjectTopic(ctx, args.projectId, args.topicId)
    await ctx.db.patch(topic._id, { excludedFromFeed: !args.included })
    return { topicId: topic._id, included: args.included }
  },
})
