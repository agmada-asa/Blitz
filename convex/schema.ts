/** Defines the persisted Blitz data model and the indexes used by app queries. */

import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

/** Validator shared by the cards table's supported learning formats. */
const cardType = v.union(
  v.literal("explain"),
  v.literal("recall"),
  v.literal("multiple_choice"),
  v.literal("connection")
)

/** Question formats stored in the new learning-item table. */
const learningItemType = v.union(
  v.literal("explain"),
  v.literal("single-choice"),
  v.literal("multiple-answer"),
  v.literal("true-false")
)

/** Stable option payload shared by choice learning items. */
const learningOption = v.object({
  id: v.string(),
  text: v.string(),
})

/** Convex schema for projects, uploaded sources, generated cards, and attempts. */
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
    originalUrl: v.optional(v.string()),
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

  topics: defineTable({
    projectId: v.id("projects"),
    parentTopicId: v.optional(v.id("topics")),
    title: v.string(),
    excludedFromFeed: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_title", ["projectId", "title"])
    .index("by_project_parent", ["projectId", "parentTopicId"]),

  concepts: defineTable({
    projectId: v.id("projects"),
    topicId: v.optional(v.id("topics")),
    title: v.string(),
    sourceIds: v.array(v.id("sources")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_title", ["projectId", "title"])
    .index("by_project_topic", ["projectId", "topicId"]),

  learningItems: defineTable({
    projectId: v.id("projects"),
    conceptId: v.id("concepts"),
    sourceIds: v.array(v.id("sources")),
    type: learningItemType,
    title: v.string(),
    body: v.string(),
    question: v.optional(v.string()),
    options: v.optional(v.array(learningOption)),
    correctOptionId: v.optional(v.string()),
    correctOptionIds: v.optional(v.array(v.string())),
    correctAnswer: v.optional(v.boolean()),
    sourceChunkId: v.optional(v.id("preparationChunks")),
    sourceChunkOrdinal: v.optional(v.number()),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_order", ["projectId", "order"])
    .index("by_project_concept_order", ["projectId", "conceptId", "order"])
    .index("by_concept_order", ["conceptId", "order"]),

  studyEvents: defineTable({
    clientEventId: v.string(),
    itemId: v.id("learningItems"),
    conceptId: v.id("concepts"),
    projectId: v.id("projects"),
    occurredAt: v.number(),
    receivedAt: v.number(),
    eventType: v.union(
      v.literal("answer"),
      v.literal("skip"),
      v.literal("exposure")
    ),
    answer: v.optional(v.union(v.string(), v.boolean(), v.array(v.string()))),
    outcome: v.optional(v.union(v.literal("correct"), v.literal("incorrect"))),
  })
    .index("by_project_clientEventId", ["projectId", "clientEventId"])
    .index("by_project_concept_occurredAt", [
      "projectId",
      "conceptId",
      "occurredAt",
    ])
    .index("by_item_occurredAt", ["itemId", "occurredAt"]),

  conceptReviews: defineTable({
    projectId: v.id("projects"),
    conceptId: v.id("concepts"),
    attemptCount: v.number(),
    correctCount: v.number(),
    incorrectCount: v.number(),
    consecutiveCorrect: v.number(),
    lastAttemptAt: v.optional(v.number()),
    dueAt: v.number(),
    lastOutcome: v.optional(
      v.union(v.literal("correct"), v.literal("incorrect"))
    ),
    updatedAt: v.number(),
  })
    .index("by_project_concept", ["projectId", "conceptId"])
    .index("by_project_dueAt", ["projectId", "dueAt"]),

  preparationJobs: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    sourceTextSnapshot: v.string(),
    sourceFilename: v.string(),
    sourceKind: v.union(
      v.literal("pdf"),
      v.literal("markdown"),
      v.literal("text"),
      v.literal("paste")
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("leased"),
      v.literal("failed"),
      v.literal("completed")
    ),
    nextChunkOrdinal: v.number(),
    totalChunks: v.optional(v.number()),
    workerId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    attemptCount: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_source", ["projectId", "sourceId"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_leaseToken", ["leaseToken"]),

  preparationChunks: defineTable({
    jobId: v.id("preparationJobs"),
    sourceId: v.id("sources"),
    ordinal: v.number(),
    chunkId: v.string(),
    totalChunks: v.number(),
    createdAt: v.number(),
  })
    .index("by_job_ordinal", ["jobId", "ordinal"])
    .index("by_job_chunkId", ["jobId", "chunkId"]),

  conversations: defineTable({
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    codexThreadId: v.optional(v.string()),
    status: v.union(
      v.literal("idle"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("failed")
    ),
    activeMessageId: v.optional(v.id("conversationMessages")),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project_item", ["projectId", "itemId"]),

  conversationMessages: defineTable({
    conversationId: v.id("conversations"),
    clientMessageId: v.string(),
    question: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed")
    ),
    reply: v.optional(v.string()),
    error: v.optional(v.string()),
    codexTurnId: v.optional(v.string()),
    workerId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversation_createdAt", ["conversationId", "createdAt"])
    .index("by_conversation_clientMessageId", [
      "conversationId",
      "clientMessageId",
    ])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_leaseToken", ["leaseToken"]),

  researchProposals: defineTable({
    projectId: v.id("projects"),
    requestId: v.string(),
    request: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("failed")
    ),
    scope: v.string(),
    topics: v.array(v.string()),
    sources: v.array(
      v.object({
        url: v.string(),
        title: v.string(),
        reason: v.string(),
        verification: v.union(
          v.literal("suggested-unverified"),
          v.literal("checked")
        ),
      })
    ),
    generatedNotes: v.array(
      v.object({
        label: v.literal("generated"),
        title: v.string(),
        description: v.string(),
        reason: v.string(),
      })
    ),
    workerId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_requestId", ["projectId", "requestId"])
    .index("by_project_createdAt", ["projectId", "createdAt"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_leaseToken", ["leaseToken"]),

  researchProposalImports: defineTable({
    proposalId: v.id("researchProposals"),
    projectId: v.id("projects"),
    sourceIndex: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("imported"),
      v.literal("failed")
    ),
    sourceId: v.optional(v.id("sources")),
    preparationJobId: v.optional(v.id("preparationJobs")),
    workerId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    failureCategory: v.optional(
      v.union(
        v.literal("site-refused"),
        v.literal("not-found"),
        v.literal("unsupported-format"),
        v.literal("needs-ocr"),
        v.literal("too-large"),
        v.literal("timeout"),
        v.literal("invalid-url"),
        v.literal("download-failed")
      )
    ),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_proposal_sourceIndex", ["proposalId", "sourceIndex"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_leaseToken", ["leaseToken"]),
})
