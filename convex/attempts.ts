/** Records study ratings and derives each project's latest progress totals. */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

/** Records a card rating after confirming the card belongs to the project. */
export const recordAttempt = mutation({
  args: {
    projectId: v.id("projects"),
    cardId: v.id("cards"),
    rating: v.union(v.literal("again"), v.literal("got_it")),
  },
  handler: async (ctx, args) => {
    const card = await ctx.db.get(args.cardId)
    if (!card || card.projectId !== args.projectId)
      throw new Error("Card does not belong to project")
    return ctx.db.insert("attempts", { ...args, createdAt: Date.now() })
  },
})

/** Computes progress from the latest rating for each card in a project. */
export const getProjectProgress = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const [cards, attempts] = await Promise.all([
      ctx.db
        .query("cards")
        .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
        .collect(),
      ctx.db
        .query("attempts")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect(),
    ])
    const latest = new Map<
      string,
      { rating: "again" | "got_it"; createdAt: number }
    >()
    for (const attempt of attempts) {
      const previous = latest.get(attempt.cardId)
      if (!previous || attempt.createdAt >= previous.createdAt)
        latest.set(attempt.cardId, attempt)
    }
    const gotIt = [...latest.values()].filter(
      (attempt) => attempt.rating === "got_it"
    ).length
    const completed = latest.size
    return {
      total: cards.length,
      completed,
      gotIt,
      again: completed - gotIt,
      percentage: cards.length ? Math.round((gotIt / cards.length) * 100) : 0,
    }
  },
})

/** Short public alias retained for existing client calls. */
export const getProgress = getProjectProgress
