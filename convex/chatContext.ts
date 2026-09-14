/** Supplies bounded project and card source snapshots to the workspace chat route. */

import { query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { retrieveProjectContext } from "./sourceRetrieval"

/** Maximum projects that one workspace chat turn may attach. */
const MAX_PROJECTS = 3
/** Maximum source characters returned across all attached projects. */
const MAX_CONTEXT_CHARACTERS = 48_000
/** Maximum source characters returned for one card attachment. */
const MAX_CARD_CONTEXT_CHARACTERS = 48_000

/** Loads and validates the prepared source snapshot associated with one card. */
async function requirePreparedCard(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  itemId: Id<"learningItems">
): Promise<{
  projectId: Id<"projects">
  item: Doc<"learningItems">
  source: {
    filename: string
    kind: "pdf" | "markdown" | "text" | "paste"
    extractedText: string
  }
}> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
  const item = await ctx.db.get(itemId)
  if (!item || item.projectId !== projectId)
    throw new Error("Learning item does not belong to project")
  if (!item.sourceChunkId)
    throw new Error("Card source chunk is not available for chat")
  const chunk = await ctx.db.get(item.sourceChunkId)
  if (!chunk) throw new Error("Card source chunk was not found")
  const job = await ctx.db.get(chunk.jobId)
  if (!job || job.projectId !== projectId || job.sourceId !== chunk.sourceId)
    throw new Error("Card source preparation snapshot was not found")
  const source = await ctx.db.get(chunk.sourceId)
  if (!source || source.projectId !== projectId)
    throw new Error("Card source was not found")
  if (
    item.sourceChunkOrdinal !== undefined &&
    item.sourceChunkOrdinal !== chunk.ordinal
  )
    throw new Error("Card source chunk ordinal no longer matches")
  return {
    projectId,
    item,
    source: {
      filename: source.filename,
      kind: source.kind,
      extractedText: job.sourceTextSnapshot.slice(
        0,
        MAX_CARD_CONTEXT_CHARACTERS
      ),
    },
  }
}

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

/** Returns one card with its bounded prepared source context for a new chat. */
export const getCard = query({
  args: { projectId: v.id("projects"), itemId: v.id("learningItems") },
  handler: async (ctx, args) => {
    const { item, source } = await requirePreparedCard(
      ctx,
      args.projectId,
      args.itemId
    )
    return {
      id: item._id,
      projectId: args.projectId,
      title: item.title,
      body: item.body,
      ...(item.deepExplanation
        ? { deepExplanation: item.deepExplanation }
        : {}),
      ...(item.question === undefined ? {} : { question: item.question }),
      ...(item.options === undefined
        ? {}
        : { options: item.options.map((option) => option.text) }),
      sourceLabel: source.filename,
      source,
    }
  },
})
