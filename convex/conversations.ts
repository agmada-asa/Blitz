/**
 * Resolves the card identity behind saved legacy card chat links.
 *
 * The card chat worker has been removed and nothing writes conversations any
 * more. This lookup remains so older `/chat` links keep opening. The
 * conversation tables stay in the schema because they hold saved history.
 */

import { query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"

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
