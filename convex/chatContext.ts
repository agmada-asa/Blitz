/** Supplies bounded project source snapshots to the server-side workspace chat route. */

import { query } from "./_generated/server"
import { v } from "convex/values"
import { retrieveProjectContext } from "./sourceRetrieval"

/** Maximum projects that one workspace chat turn may attach. */
const MAX_PROJECTS = 3
/** Maximum source characters returned across all attached projects. */
const MAX_CONTEXT_CHARACTERS = 48_000

/** Loads real project titles and bounded ready-source text for one chat turn. */
export const getProjects = query({
  args: {
    projectIds: v.array(v.id("projects")),
    question: v.optional(v.string()),
  },
  handler: async (ctx, { projectIds, question }) => {
    if (projectIds.length > MAX_PROJECTS)
      throw new Error(`Attach at most ${MAX_PROJECTS} projects`)
    if (new Set(projectIds).size !== projectIds.length)
      throw new Error("Attached projects must be unique")

    let remaining = MAX_CONTEXT_CHARACTERS
    const projects = []
    for (const projectId of projectIds) {
      const project = await ctx.db.get(projectId)
      if (!project) throw new Error("An attached project was not found")
      // Search the indexed library instead of attaching source prefixes. Old
      // projects still load; their text becomes searchable after legacy export.
      const retrieved =
        question?.trim() && remaining > 0
          ? await retrieveProjectContext(
              ctx,
              projectId,
              question.slice(0, 500),
              {
                maxChars: Math.min(16_000, remaining),
                neighborRadius: 1,
              }
            )
          : { results: [] }
      const boundedSources = retrieved.results.map(({ text, citation }) => {
        const labels = citation.references.map((reference) => reference.label)
        const extractedText = text.slice(0, remaining)
        remaining -= extractedText.length
        return {
          filename: citation.sourceFilename,
          kind: "text" as const,
          extractedText,
          citation: [
            citation.sourceFilename,
            ...new Set(labels),
            `chunk ${citation.ordinal + 1}`,
          ].join(", "),
        }
      })
      projects.push({
        id: project._id,
        title: project.title,
        sources: boundedSources,
      })
    }
    return projects
  },
})
