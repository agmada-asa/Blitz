/** Exposes source-backed concept connections to the project view and generation worker. */

import { query } from "./_generated/server"
import { v } from "convex/values"

/** Maximum rows returned in one map snapshot, matching the bounded learning path. */
const MAX_MAP_ROWS = 2_000

/** Returns taught concepts and cited relationships without shipping source bodies to the client. */
export const getProjectMap = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId))) return null
    const [concepts, topics, sources, relationships] = await Promise.all([
      ctx.db
        .query("concepts")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_MAP_ROWS + 1),
      ctx.db
        .query("topics")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_MAP_ROWS + 1),
      ctx.db
        .query("sources")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_MAP_ROWS + 1),
      ctx.db
        .query("conceptRelationships")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_MAP_ROWS + 1),
    ])
    if (
      [concepts, topics, sources, relationships].some(
        (rows) => rows.length > MAX_MAP_ROWS
      )
    )
      throw new Error("Concept map exceeds its current project limit")
    const topicTitles = new Map(
      topics.map((topic) => [String(topic._id), topic.title])
    )
    const sourceFilenames = new Map(
      sources.map((source) => [String(source._id), source.filename])
    )
    return {
      concepts: concepts.map((concept) => ({
        id: concept._id,
        title: concept.title,
        aliases: concept.aliases ?? [],
        topicTitle: concept.topicId
          ? (topicTitles.get(String(concept.topicId)) ?? "Other material")
          : "Other material",
        sourceIds: concept.sourceIds,
      })),
      relationships: relationships.map((relationship) => ({
        id: relationship._id,
        fromConceptId: relationship.fromConceptId,
        toConceptId: relationship.toConceptId,
        kind: relationship.kind,
        explanation: relationship.explanation,
        sourceId: relationship.sourceId,
        sourceFilename:
          sourceFilenames.get(String(relationship.sourceId)) ?? "Source",
        evidence: relationship.evidence,
      })),
      sources: sources.map((source) => ({
        id: source._id,
        filename: source.filename,
      })),
    }
  },
})
