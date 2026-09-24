/** Defines the persisted Blitz data model and the indexes used by app queries. */

import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { citationFields } from "./citationFields"

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

/** Immutable prompt snapshot and learner-owned answer state for written practice. */
const writingActivityItem = v.object({
  itemId: v.id("learningItems"),
  title: v.string(),
  prompt: v.string(),
  sourceLabels: v.array(v.string()),
  reference: v.string(),
  answer: v.optional(v.string()),
  revealed: v.boolean(),
})

/** Bounded, user-visible research lifecycle event with no model internals. */
const researchActivityEvent = v.object({
  stage: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("searching"),
    v.literal("synthesizing"),
    v.literal("completed"),
    v.literal("failed")
  ),
  label: v.optional(v.string()),
  query: v.optional(v.string()),
  tool: v.optional(v.literal("web_search")),
  occurredAt: v.number(),
  elapsedMs: v.number(),
})

/** Convex schema for projects, uploaded sources, generated cards, and attempts. */
export default defineSchema({
  projects: defineTable({
    /** Transitional metadata retained for legacy standalone agent tasks. */
    agentAutonomy: v.optional(
      v.union(v.literal("approval"), v.literal("project"), v.literal("full"))
    ),
    agentInstructions: v.optional(v.string()),
    title: v.string(),
    createdAt: v.number(),
    /** Optional stable key for the project-local desktop workspace. */
    workspaceKey: v.optional(v.string()),
    /** Optional relative workspace directory retained for desktop clients. */
    workspaceRelativePath: v.optional(v.string()),
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
    /** Deterministic import identity used to make retries idempotent. */
    importFingerprint: v.optional(v.string()),
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    /** Project-local file key; never an absolute path. */
    relativeKey: v.optional(v.string()),
    /** MIME type reported by the upload adapter. */
    mimeType: v.optional(v.string()),
    /** Original file size in bytes, when available. */
    sizeBytes: v.optional(v.number()),
    /** Content hash used for duplicate detection and retry idempotency. */
    contentHash: v.optional(v.string()),
    /** True when original bytes are retained but no deterministic parser exists. */
    unsupported: v.optional(v.boolean()),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"])
    .index("by_project_fingerprint", ["projectId", "importFingerprint"])
    .index("by_project_contentHash", ["projectId", "contentHash"]),

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
    /** Optional longer explanation for the walkthrough card's back face. */
    deepExplanation: v.optional(v.string()),
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

  writingActivities: defineTable({
    projectId: v.id("projects"),
    topicId: v.optional(v.id("topics")),
    requestId: v.string(),
    status: v.union(v.literal("active"), v.literal("completed")),
    items: v.array(writingActivityItem),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_requestId", ["projectId", "requestId"])
    .index("by_project_topic_createdAt", ["projectId", "topicId", "createdAt"])
    .index("by_project_createdAt", ["projectId", "createdAt"]),

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
    /** Approved research topic filter copied into the immutable job snapshot. */
    learningScope: v.optional(v.string()),
    /** Provider selection copied into the immutable generation snapshot. */
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    generationModel: v.optional(v.string()),
    generationEffort: v.optional(v.string()),
    /** Number of generated learning items committed so far; absent on legacy jobs. */
    generatedItemCount: v.optional(v.number()),
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

  /** Durable ingestion lifecycle for original files and derived chunks. */
  ingestionJobs: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed")
    ),
    sourceHash: v.optional(v.string()),
    /** Prevents concurrent request and recovery workers from indexing one upload. */
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_createdAt", ["projectId", "createdAt"])
    .index("by_source", ["sourceId"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  /** Bounded searchable source section with deterministic attribution. */
  sourceChunks: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    ingestionJobId: v.optional(v.id("ingestionJobs")),
    ordinal: v.number(),
    text: v.string(),
    textHash: v.string(),
    startOffset: v.number(),
    endOffset: v.number(),
    sectionTitle: v.optional(v.string()),
    references: v.array(
      v.object({
        kind: v.optional(
          v.union(v.literal("page"), v.literal("slide"), v.literal("time"))
        ),
        label: v.string(),
        value: v.string(),
        startOffset: v.number(),
        endOffset: v.number(),
      })
    ),
    createdAt: v.number(),
  })
    .index("by_project_source_ordinal", ["projectId", "sourceId", "ordinal"])
    .index("by_source_ordinal", ["sourceId", "ordinal"])
    .index("by_project", ["projectId"])
    .index("by_textHash", ["textHash"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["projectId", "sourceId"],
    }),

  /** Optional bounded outline entries used to orient retrieval. */
  sourceOutlines: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    ordinal: v.number(),
    title: v.string(),
    startChunkOrdinal: v.number(),
    endChunkOrdinal: v.number(),
    createdAt: v.number(),
  })
    .index("by_source_ordinal", ["sourceId", "ordinal"])
    .index("by_project_source", ["projectId", "sourceId"]),

  /** Files created by local agents, tracked without storing their contents. */
  artifacts: defineTable({
    projectId: v.id("projects"),
    relativeKey: v.string(),
    kind: v.union(v.literal("file"), v.literal("directory")),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("deleted")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_updatedAt", ["projectId", "updatedAt"])
    .index("by_project_key", ["projectId", "relativeKey"]),

  /** Bounded lifecycle metadata for a project-local agent task. */
  agentTasks: defineTable({
    /** Legacy task snapshots; new agent turns belong to workspace chats. */
    autonomy: v.optional(
      v.union(v.literal("approval"), v.literal("project"), v.literal("full"))
    ),
    additionalInstructions: v.optional(v.string()),
    cancelRequested: v.optional(v.boolean()),
    expiresAt: v.optional(v.number()),
    response: v.optional(v.string()),
    threadId: v.optional(v.string()),
    turnId: v.optional(v.string()),

    projectId: v.id("projects"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed")
    ),
    title: v.string(),
    request: v.string(),
    artifactIds: v.optional(v.array(v.id("artifacts"))),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project_updatedAt", ["projectId", "updatedAt"]),

  /** One global record for the provider, model, and reasoning choices used by each AI task. */
  aiModelSettings: defineTable({
    /** Per-provider interactive chat approval policy; omitted on legacy records. */
    providerApprovalPolicies: v.optional(v.record(v.string(), v.string())),
    scope: v.literal("global"),
    researchProvider: v.optional(v.string()),
    replyProvider: v.optional(v.string()),
    cardGenerationProvider: v.optional(v.string()),
    researchModel: v.string(),
    replyModel: v.string(),
    cardGenerationModel: v.string(),
    researchEffort: v.optional(v.string()),
    replyEffort: v.optional(v.string()),
    cardGenerationEffort: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_scope", ["scope"]),

  /** One global record for the ordered Kokoro voices used as podcast hosts. */
  audioVoiceSettings: defineTable({
    scope: v.literal("global"),
    voiceIds: v.array(
      v.union(
        v.literal("af_heart"),
        v.literal("af_bella"),
        v.literal("af_nicole"),
        v.literal("am_fenrir"),
        v.literal("am_puck")
      )
    ),
    updatedAt: v.number(),
  }).index("by_scope", ["scope"]),

  /** General Blitz sessions opened from the top-level Chat tab. */
  workspaceChats: defineTable({
    /** Optional owning project. Chats can exist independently of projects. */
    projectId: v.optional(v.id("projects")),
    title: v.string(),
    /** Optional chat agent policy; legacy chats use approval with no extra instructions. */
    agentAutonomy: v.optional(
      v.union(v.literal("approval"), v.literal("project"), v.literal("full"))
    ),
    agentInstructions: v.optional(v.string()),
    workingProjectId: v.optional(v.id("projects")),
    /** Version of the app-owned interactive tool set attached to the provider session. */
    agentRequestToolsVersion: v.optional(v.number()),
    /** Manual history state. Optional keeps chats created before this feature readable. */
    isUnread: v.optional(v.boolean()),
    isPinned: v.optional(v.boolean()),
    isArchived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    branchedFromChatId: v.optional(v.id("workspaceChats")),
    branchedFromMessageId: v.optional(v.id("workspaceChatMessages")),
    /** Provider snapshot for new sessions; absent on legacy Codex chats. */
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerModel: v.optional(v.string()),
    providerEffort: v.optional(v.string()),
    codexThreadId: v.optional(v.string()),
    codexContextReady: v.optional(v.boolean()),
    status: v.union(
      v.literal("idle"),
      v.literal("running"),
      v.literal("failed")
    ),
    activeMessageId: v.optional(v.id("workspaceChatMessages")),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_updatedAt", ["updatedAt"])
    .index("by_project_updatedAt", ["projectId", "updatedAt"])
    .index("by_pinned_updatedAt", ["isPinned", "updatedAt"])
    .index("by_archived_updatedAt", ["isArchived", "updatedAt"]),

  /** User and assistant messages retained for a general Blitz session. */
  workspaceChatMessages: defineTable({
    /** Immutable passages allowed as links in this reply, retained across branches. */
    citations: v.optional(v.array(citationFields)),
    chatId: v.id("workspaceChats"),
    clientMessageId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    /** Cumulative internal thought, reasoning, or commentary trace for assistant messages. */
    thought: v.optional(v.string()),
    /** Bounded provider tool lifecycle records retained for the assistant activity timeline. */
    providerEvents: v.optional(
      v.array(
        v.object({
          id: v.string(),
          type: v.literal("tool"),
          title: v.string(),
          status: v.union(
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed")
          ),
          detail: v.optional(v.string()),
          startedAt: v.optional(v.number()),
          completedAt: v.optional(v.number()),
        })
      )
    ),
    /** Wall-clock duration of the completed turn in milliseconds. */
    durationMs: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed")
    ),
    providerTurnId: v.optional(v.string()),
    codexTurnId: v.optional(v.string()),
    /** Pending or decided agent request attached to this assistant turn. */
    agentApproval: v.optional(
      v.object({
        id: v.string(),
        /** Native provider request identifier, when the provider exposes one. */
        providerRequestId: v.optional(v.string()),
        method: v.string(),
        /** Composer control family; omitted on legacy approval records. */
        kind: v.optional(
          v.union(
            v.literal("approval"),
            v.literal("question"),
            v.literal("form"),
            v.literal("url")
          )
        ),
        /** Human-readable title shown in the composer request panel. */
        title: v.optional(v.string()),
        /** Optional prompt shown above structured controls. */
        prompt: v.optional(v.string()),
        /** Serialized bounded questions, form fields, or URL metadata. */
        input: v.optional(v.string()),
        details: v.string(),
        status: v.union(
          v.literal("pending"),
          v.literal("approved"),
          v.literal("denied"),
          v.literal("expired"),
          v.literal("cancelled")
        ),
        expiresAt: v.number(),
        /** Serialized user response consumed by the waiting provider turn. */
        response: v.optional(v.string()),
        createdAt: v.optional(v.number()),
      })
    ),
    /** Bounded interaction history retained after each request is consumed. */
    agentRequests: v.optional(
      v.array(
        v.object({
          id: v.string(),
          providerRequestId: v.optional(v.string()),
          method: v.string(),
          kind: v.optional(
            v.union(
              v.literal("approval"),
              v.literal("question"),
              v.literal("form"),
              v.literal("url")
            )
          ),
          title: v.optional(v.string()),
          prompt: v.optional(v.string()),
          input: v.optional(v.string()),
          details: v.string(),
          status: v.union(
            v.literal("pending"),
            v.literal("approved"),
            v.literal("denied"),
            v.literal("expired"),
            v.literal("cancelled")
          ),
          expiresAt: v.number(),
          response: v.optional(v.string()),
          completedAt: v.optional(v.number()),
          createdAt: v.optional(v.number()),
        })
      )
    ),
    /** Immutable user annotations attached to this turn. */
    annotations: v.optional(
      v.array(
        v.object({
          id: v.string(),
          number: v.optional(v.number()),
          messageId: v.string(),
          selectedText: v.string(),
          note: v.string(),
          createdAt: v.number(),
        })
      )
    ),
    /** Bounded steering notes provided by the user to guide an interrupted continuation. */
    steeringNotes: v.optional(
      v.array(
        v.object({
          text: v.string(),
          steeredAt: v.number(),
        })
      )
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chat_createdAt", ["chatId", "createdAt"])
    .index("by_clientMessageId", ["clientMessageId"]),

  /** Context items introduced by one message in a general Codex thread. */
  workspaceChatAttachments: defineTable({
    documentId: v.optional(v.id("chatDocuments")),
    chatId: v.id("workspaceChats"),
    clientMessageId: v.string(),
    kind: v.union(
      v.literal("card"),
      v.literal("project"),
      v.literal("file"),
      v.literal("link")
    ),
    label: v.string(),
    mimeType: v.optional(
      v.union(
        v.literal("image/png"),
        v.literal("image/jpeg"),
        v.literal("image/webp"),
        v.literal("image/gif")
      )
    ),
    projectId: v.optional(v.id("projects")),
    itemId: v.optional(v.id("learningItems")),
    text: v.optional(v.string()),
    url: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_chat_createdAt", ["chatId", "createdAt"]),

  /** Ad hoc chat uploads retain originals without entering study generation. */
  chatDocuments: defineTable({
    /** Project owner for legacy/project-scoped uploads; absent for drafts. */
    projectId: v.optional(v.id("projects")),
    /** Opaque server-issued token accepted only until the document is bound. */
    ownerToken: v.optional(v.string()),
    /** Chat owner assigned when a draft is first sent. */
    chatId: v.optional(v.id("workspaceChats")),
    filename: v.string(),
    relativeKey: v.string(),
    mimeType: v.string(),
    text: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_ownerToken", ["ownerToken"])
    .index("by_chat", ["chatId"]),

  conversations: defineTable({
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    /** Provider snapshot for this card conversation; absent on legacy Codex chats. */
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerModel: v.optional(v.string()),
    providerEffort: v.optional(v.string()),
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
    providerTurnId: v.optional(v.string()),
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
    /** Provider selection copied into the immutable planning snapshot. */
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    researchModel: v.optional(v.string()),
    researchEffort: v.optional(v.string()),
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
    /** Optional bounded activity timeline for active and completed research. */
    activity: v.optional(v.array(researchActivityEvent)),
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
    /** Durable multi-part import checkpoint; absent on legacy single-part rows. */
    partCount: v.optional(v.number()),
    completedPartCount: v.optional(v.number()),
    partSourceIds: v.optional(v.array(v.id("sources"))),
    partPreparationJobIds: v.optional(v.array(v.id("preparationJobs"))),
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
