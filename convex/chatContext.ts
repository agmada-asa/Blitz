/** Supplies bounded project source snapshots to the server-side workspace chat route. */

import { query } from "./_generated/server"
import { v } from "convex/values"

/** Maximum projects that one workspace chat turn may attach. */
const MAX_PROJECTS = 3
/** Maximum ready sources included from one attached project. */
const MAX_SOURCES_PER_PROJECT = 8
/** Maximum source characters returned across all attached projects. */
const MAX_CONTEXT_CHARACTERS = 48_000

/** Loads real project titles and bounded ready-source text for one chat turn. */
export const getProjects = query({
  args: { projectIds: v.array(v.id("projects")) },
  handler: async (ctx, { projectIds }) => {
    if (projectIds.length > MAX_PROJECTS)
      throw new Error(`Attach at most ${MAX_PROJECTS} projects`)
    if (new Set(projectIds).size !== projectIds.length)
      throw new Error("Attached projects must be unique")

    let remaining = MAX_CONTEXT_CHARACTERS
    const projects = []
    for (const projectId of projectIds) {
      const project = await ctx.db.get(projectId)
      if (!project) throw new Error("An attached project was not found")
      const sources = await ctx.db
        .query("sources")
        .withIndex("by_project_status", (source) =>
          source.eq("projectId", projectId).eq("status", "ready")
        )
        .order("desc")
        .take(MAX_SOURCES_PER_PROJECT)
      const boundedSources = []
      for (const source of sources) {
        if (remaining <= 0) break
        const extractedText = source.extractedText.slice(0, remaining)
        remaining -= extractedText.length
        boundedSources.push({
          filename: source.filename,
          kind: source.kind,
          extractedText,
          ...(source.originalUrl ? { originalUrl: source.originalUrl } : {}),
        })
      }
      projects.push({
        id: project._id,
        title: project.title,
        sources: boundedSources,
      })
    }
    return projects
  },
})
