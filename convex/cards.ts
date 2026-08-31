import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const cardType = v.union(v.literal("explain"), v.literal("recall"), v.literal("multiple_choice"), v.literal("connection"));
const card = v.object({
  sourceId: v.id("sources"), type: cardType, title: v.string(), body: v.string(),
  question: v.optional(v.string()), answer: v.optional(v.string()), options: v.optional(v.array(v.string())),
  correctOption: v.optional(v.number()), sourceLabel: v.string(), order: v.number(),
});

export const insertCards = mutation({
  args: { projectId: v.id("projects"), cards: v.array(card) },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found");
    if (args.cards.length > 100) throw new Error("Too many cards");
    const ids = [];
    for (const item of args.cards) {
      const source = await ctx.db.get(item.sourceId);
      if (!source || source.projectId !== args.projectId) throw new Error("Card source does not belong to project");
      if (item.type === "multiple_choice" && (!item.options || item.options.length !== 4 || item.correctOption === undefined || item.correctOption < 0 || item.correctOption > 3)) {
        throw new Error("Multiple choice cards require four options and a valid answer");
      }
      ids.push(await ctx.db.insert("cards", { projectId: args.projectId, ...item }));
    }
    return ids;
  },
});

export const batchInsertCards = insertCards;

export const listProjectCards = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.query("cards").withIndex("by_project_order", (q) => q.eq("projectId", args.projectId)).order("asc").collect(),
});
