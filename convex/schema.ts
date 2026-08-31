import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

const cardType = v.union(
  v.literal("explain"),
  v.literal("recall"),
  v.literal("multiple_choice"),
  v.literal("connection")
)

export default defineSchema({
  projects: defineTable({
    title: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  sources: defineTable({
    projectId: v.id("projects"),
    filename: v.string(),
    kind: v.union(
      v.literal("pdf"),
      v.literal("markdown"),
      v.literal("text"),
      v.literal("paste")
    ),
    extractedText: v.string(),
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"]),

  cards: defineTable({
    projectId: v.id("projects"),
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
    .index("by_project_order", ["projectId", "order"])
    .index("by_source_order", ["sourceId", "order"]),

  attempts: defineTable({
    projectId: v.id("projects"),
    cardId: v.id("cards"),
    rating: v.union(v.literal("again"), v.literal("got_it")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_card", ["projectId", "cardId"])
    .index("by_card_createdAt", ["cardId", "createdAt"]),
})
