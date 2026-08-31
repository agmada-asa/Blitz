/** Validates and persists generated cards, then exposes ordered project decks. */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

/** Validator for every study-card format stored by Blitz. */
const cardType = v.union(
  v.literal("explain"),
  v.literal("recall"),
  v.literal("multiple_choice"),
  v.literal("connection")
)
/** Input validator for generated card fields before business-rule checks. */
const card = v.object({
  sourceId: v.id("sources"),
  type: cardType,
  title: v.string(),
  body: v.string(),
  question: v.optional(v.string()),
  answer: v.optional(v.string()),
  options: v.optional(v.array(v.string())),
  correctOption: v.optional(v.number()),
  sourceLabel: v.string(),
  order: v.number(),
})

/** Inserts one bounded, internally consistent card batch for a project. */
export const insertCards = mutation({
  args: { projectId: v.id("projects"), cards: v.array(card) },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    if (args.cards.length !== 10)
      throw new Error("A generated set must contain exactly 10 cards")
    const orders = new Set<number>()
    const ids = []
    for (const item of args.cards) {
      const source = await ctx.db.get(item.sourceId)
      if (!source || source.projectId !== args.projectId)
        throw new Error("Card source does not belong to project")
      if (
        !item.title.trim() ||
        item.title.length > 180 ||
        !item.body.trim() ||
        item.body.length > 900 ||
        !item.sourceLabel.trim() ||
        item.sourceLabel.length > 180
      ) {
        throw new Error("Card text is invalid")
      }
      if (!Number.isSafeInteger(item.order) || item.order < 0)
        throw new Error("Card order is invalid")
      if (orders.has(item.order)) throw new Error("Card orders must be unique")
      orders.add(item.order)
      if (
        item.question !== undefined &&
        (!item.question.trim() || item.question.length > 500)
      ) {
        throw new Error("Card question is invalid")
      }
      if (
        item.answer !== undefined &&
        (!item.answer.trim() || item.answer.length > 700)
      ) {
        throw new Error("Card answer is invalid")
      }
      if (
        item.type === "recall" &&
        (item.question === undefined || item.answer === undefined)
      ) {
        throw new Error("Recall cards require a question and answer")
      }
      if (
        item.type === "multiple_choice" &&
        (!item.options ||
          item.options.length !== 4 ||
          item.options.some(
            (option) => !option.trim() || option.length > 300
          ) ||
          new Set(item.options.map((option) => option.trim())).size !== 4 ||
          !item.question ||
          !item.answer ||
          item.correctOption === undefined ||
          item.correctOption < 0 ||
          item.correctOption > 3)
      ) {
        throw new Error(
          "Multiple choice cards require four options and a valid answer"
        )
      }
      ids.push(
        await ctx.db.insert("cards", { projectId: args.projectId, ...item })
      )
    }
    return ids
  },
})

/** Public alias used by the source uploader for batch persistence. */
export const batchInsertCards = insertCards

/** Lists a project's cards in their generated study order. */
export const listProjectCards = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) =>
    ctx.db
      .query("cards")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .collect(),
})
