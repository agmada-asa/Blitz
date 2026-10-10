/** Defines the persisted Blitz data model and the indexes used by app queries. */

import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { citationFields } from "./citationFields"
import { examAnswerFields, examQuestionFields, examResultFields } from "./examFields"

/** Validator shared by the cards table's supported learning formats. */
const cardType = v.union(
  v.literal("explain"),
  v.literal("recall"),
  v.literal("multiple_choice"),
  v.literal("connection")
)

/**
 * Question formats stored in the new learning-item table. The structured
 * formats (cloze, ordering, matching, code output) are answered with a list
 * of strings; see `lib/learning/core.ts` for how each is scored.
 */
const learningItemType = v.union(
  v.literal("explain"),
  v.literal("single-choice"),
  v.literal("multiple-answer"),
  v.literal("true-false"),
  v.literal("cloze"),
  v.literal("ordering"),
  v.literal("matching"),
  v.literal("code-output")
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
    /** Five-step length preference copied into each new content generation job. */
    contentDepth: v.optional(v.number()),
    title: v.string(),
    createdAt: v.number(),
    /** Optional stable key for the project-local desktop workspace. */
    workspaceKey: v.optional(v.string()),
    /** Optional relative workspace directory retained for desktop clients. */
    workspaceRelativePath: v.optional(v.string()),
  }).index("by_createdAt", ["createdAt"]),

  /**
   * One teachable block of a module, such as a week or a lecture. Uploads are
   * grouped into units, and each unit has its own Teach session.
   */
  units: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    /** Whether the title was suggested by Blitz or set by the learner. */
    titleSource: v.union(v.literal("auto"), v.literal("user")),
    /** Position in the module's learning path; lower comes first. */
    order: v.number(),
    /** When the learner first started this unit in Teach or answered one of its questions. */
    startedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project_order", ["projectId", "order"]),

  sources: defineTable({
    projectId: v.id("projects"),
    /** Unit this source teaches; unset for sources imported before units existed. */
    unitId: v.optional(v.id("units")),
    /**
     * `reference` marks a whole book or other very large source. It belongs to
     * the module rather than one unit, and Teach searches it for passages
     * relevant to whatever is being taught.
     */
    role: v.optional(v.literal("reference")),
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
    .index("by_project_contentHash", ["projectId", "contentHash"])
    .index("by_unit", ["unitId"])
    .index("by_project_role", ["projectId", "role"]),

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
    /** Unit whose Teach session introduced this concept. */
    unitId: v.optional(v.id("units")),
    topicId: v.optional(v.id("topics")),
    title: v.string(),
    /** Other source terms that refer to this same taught idea. */
    aliases: v.optional(v.array(v.string())),
    sourceIds: v.array(v.id("sources")),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_title", ["projectId", "title"])
    .index("by_project_topic", ["projectId", "topicId"]),

  /** One source-supported connection between two concepts in a project. */
  conceptRelationships: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    fromConceptId: v.id("concepts"),
    toConceptId: v.id("concepts"),
    kind: v.union(
      v.literal("prerequisite_for"),
      v.literal("part_of"),
      v.literal("causes"),
      v.literal("contrasts_with"),
      v.literal("applies_to"),
      v.literal("related_to")
    ),
    explanation: v.string(),
    evidence: v.array(
      v.object({
        sectionId: v.optional(v.string()),
        locator: v.string(),
      })
    ),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_source", ["projectId", "sourceId"])
    .index("by_project_from", ["projectId", "fromConceptId"])
    .index("by_project_to", ["projectId", "toConceptId"]),

  learningItems: defineTable({
    projectId: v.id("projects"),
    conceptId: v.id("concepts"),
    /** Unit whose Teach session produced this item. */
    unitId: v.optional(v.id("units")),
    /**
     * Stable `<messageId>:<quizId>` identity for a question asked inside a
     * Teach session or saved from a chat reply, so answering or saving it
     * twice reuses one item.
     */
    teachKey: v.optional(v.string()),
    /**
     * `teach` for lesson quizzes, `bank` for generated practice questions,
     * `chat` for chat quizzes the learner saved to a unit, `exam` for choice
     * questions on an exam paper. Exam items stay out of the feed and drills
     * so a paper's answers are not shown before it is taken.
     */
    origin: v.optional(
      v.union(v.literal("teach"), v.literal("bank"), v.literal("chat"), v.literal("exam"))
    ),
    /**
     * Outcome and time of the latest answer, kept on the item so drills and
     * the feed can rank questions without reading every answer event.
     */
    lastOutcome: v.optional(v.union(v.literal("correct"), v.literal("incorrect"))),
    lastAnsweredAt: v.optional(v.number()),
    sourceIds: v.array(v.id("sources")),
    type: learningItemType,
    title: v.string(),
    body: v.string(),
    /** Optional longer explanation for the walkthrough card's back face. */
    deepExplanation: v.optional(v.string()),
    /** Last lesson rewrite; answer events continue to refer to this stable item. */
    updatedAt: v.optional(v.number()),
    /** Superseded lessons stay stored for study history but leave live views. */
    archivedAt: v.optional(v.number()),
    /** Source locations supplied by the agent for this lesson. */
    sourceReferences: v.optional(v.array(v.object({
      sourceId: v.id("sources"),
      locator: v.string(),
    }))),
    question: v.optional(v.string()),
    options: v.optional(v.array(learningOption)),
    correctOptionId: v.optional(v.string()),
    /**
     * Multiple-answer: the correct set. Ordering: every option id in the
     * correct order. Matching: the matching option id for each prompt.
     */
    correctOptionIds: v.optional(v.array(v.string())),
    correctAnswer: v.optional(v.boolean()),
    /** Matching: the left-hand items, each paired with one option. */
    matchPrompts: v.optional(v.array(v.string())),
    /**
     * Cloze: accepted answers for each numbered blank, in blank order.
     * Code output: a single entry listing the accepted outputs.
     */
    acceptedAnswers: v.optional(v.array(v.array(v.string()))),
    sourceChunkId: v.optional(v.id("preparationChunks")),
    sourceChunkOrdinal: v.optional(v.number()),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_order", ["projectId", "order"])
    .index("by_project_concept_order", ["projectId", "conceptId", "order"])
    .index("by_concept_order", ["conceptId", "order"])
    .index("by_project_teachKey", ["projectId", "teachKey"])
    .index("by_unit", ["unitId"]),

  /** One run that writes practice questions for a unit's question bank. */
  questionGenerations: defineTable({
    projectId: v.id("projects"),
    unitId: v.id("units"),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed")
    ),
    requestedCount: v.number(),
    createdCount: v.number(),
    /** Questions dropped by validation. */
    rejectedCount: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_unit_startedAt", ["unitId", "startedAt"])
    .index("by_startedAt", ["startedAt"]),

  /**
   * A past paper imported from an upload, or a mock paper written from a
   * module's units. While `processing`, a background run extracts or writes
   * the questions; `runStartedAt` identifies that run and acts as its lease.
   */
  examPapers: defineTable({
    projectId: v.id("projects"),
    kind: v.union(v.literal("past"), v.literal("mock")),
    title: v.string(),
    status: v.union(v.literal("processing"), v.literal("ready"), v.literal("failed")),
    /** Learner-facing reason the last run failed. */
    error: v.optional(v.string()),
    /** Past papers: the uploaded paper, stored as a module source with no unit. */
    sourceId: v.optional(v.id("sources")),
    /** Past papers: optional uploaded solutions or mark scheme. */
    solutionsSourceId: v.optional(v.id("sources")),
    /** Mock papers: units the paper covers. */
    unitIds: v.optional(v.array(v.id("units"))),
    /** Time allowed in minutes: stated on a past paper, or chosen for a mock. */
    durationMinutes: v.optional(v.number()),
    /** Total marks printed on a past paper, when stated. */
    statedTotalMarks: v.optional(v.number()),
    /** Sum of question marks, set when the paper is ready. */
    totalMarks: v.optional(v.number()),
    /** Empty until the paper is ready. */
    questions: v.array(examQuestionFields),
    /** Questions dropped by validation. */
    rejectedCount: v.optional(v.number()),
    runStartedAt: v.number(),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_project_createdAt", ["projectId", "createdAt"])
    .index("by_project_source", ["projectId", "sourceId"])
    .index("by_createdAt", ["createdAt"]),

  /**
   * One sitting of an exam paper. Answers autosave while `in_progress`, so a
   * reload resumes. On submit, choice questions are marked at once and
   * written answers wait for a background grading run.
   */
  examAttempts: defineTable({
    projectId: v.id("projects"),
    paperId: v.id("examPapers"),
    status: v.union(v.literal("in_progress"), v.literal("submitted")),
    durationMinutes: v.number(),
    startedAt: v.number(),
    /** Answers are accepted until shortly after this time. */
    deadlineAt: v.number(),
    updatedAt: v.number(),
    answers: v.array(examAnswerFields),
    submittedAt: v.optional(v.number()),
    /** Set when time ran out before the learner submitted. */
    autoSubmitted: v.optional(v.boolean()),
    /** One result per question, in paper order, once submitted. */
    results: v.optional(v.array(examResultFields)),
    gradingStatus: v.optional(
      v.union(
        v.literal("not_needed"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed")
      )
    ),
    /** Identifies the grading run and acts as its lease. */
    gradingStartedAt: v.optional(v.number()),
    gradingError: v.optional(v.string()),
    /** When the latest grading run finished or failed. */
    gradedAt: v.optional(v.number()),
    /** Marks awarded so far and marks available on the paper. */
    awardedMarks: v.optional(v.number()),
    availableMarks: v.optional(v.number()),
  })
    .index("by_paper_startedAt", ["paperId", "startedAt"])
    .index("by_submittedAt", ["submittedAt"]),

  /** Previous explanation text retained when a new source revises a lesson. */
  lessonPageRevisions: defineTable({
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    jobId: v.id("contentGenerationJobs"),
    title: v.string(),
    body: v.string(),
    deepExplanation: v.optional(v.string()),
    sourceIds: v.array(v.id("sources")),
    sourceReferences: v.optional(v.array(v.object({
      sourceId: v.id("sources"),
      locator: v.string(),
    }))),
    replacedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_item_replacedAt", ["itemId", "replacedAt"]),

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
    .index("by_item_occurredAt", ["itemId", "occurredAt"])
    .index("by_occurredAt", ["occurredAt"])
    .index("by_eventType_occurredAt", ["eventType", "occurredAt"]),

  /**
   * Learning milestones other than answers, used for XP and streaks: a Teach
   * section reached, or a unit finished.
   */
  learningActivity: defineTable({
    kind: v.union(v.literal("section"), v.literal("unit")),
    projectId: v.id("projects"),
    unitId: v.id("units"),
    /** Section id for `section` milestones, so one section counts once. */
    sectionId: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_occurredAt", ["occurredAt"])
    .index("by_unit_kind", ["unitId", "kind"]),

  /** Personal study preferences for this installation. */
  studyPreferences: defineTable({
    scope: v.literal("global"),
    /** XP that counts as a completed day for the streak. */
    dailyGoalXp: v.number(),
    /**
     * Local hour (0–23) after which the desktop app reminds the learner if the
     * goal is not met; null turns reminders off, unset uses the default.
     */
    reminderHour: v.optional(v.union(v.number(), v.null())),
    updatedAt: v.number(),
  }).index("by_scope", ["scope"]),

  conceptReviews: defineTable({
    projectId: v.id("projects"),
    conceptId: v.id("concepts"),
    /** Distinct question items with at least one valid recorded answer. */
    answeredQuestionCount: v.optional(v.number()),
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

  /** Agent-led content work for one source, with durable page import progress. */
  contentGenerationJobs: defineTable({
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    status: v.union(
      v.literal("queued"),
      v.literal("leased"),
      v.literal("failed"),
      v.literal("completed")
    ),
    depth: v.number(),
    /** Approved research scope restricts what imported references may teach. */
    learningScope: v.optional(v.string()),
    providerId: v.optional(v.string()),
    providerInstanceId: v.optional(v.string()),
    generationModel: v.optional(v.string()),
    generationEffort: v.optional(v.string()),
    /** Current worker step, shown while lessons are being prepared. */
    stage: v.optional(
      v.union(
        v.literal("preparing"),
        v.literal("generating"),
        v.literal("validating"),
        v.literal("importing")
      )
    ),
    /** Bounded provider commentary and tool activity for the source detail view. */
    thought: v.optional(v.string()),
    activity: v.optional(
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
    startedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    totalPages: v.optional(v.number()),
    /** Section accounting retained after temporary agent draft files are removed. */
    coverage: v.optional(v.array(v.object({
      sectionId: v.string(),
      status: v.union(v.literal("included"), v.literal("skipped")),
      pageKeys: v.array(v.string()),
      reason: v.optional(v.string()),
    }))),
    importedPages: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_source", ["projectId", "sourceId"])
    .index("by_status_createdAt", ["status", "createdAt"])
    /** Finds a project's active lease before another source starts generating. */
    .index("by_project_status_lease", ["projectId", "status", "leaseExpiresAt"])
    /** Finds expired leases without active jobs hiding them in the queue. */
    .index("by_status_lease", ["status", "leaseExpiresAt"]),

  /** Idempotent page commits allow a large agent draft to resume after a failed import. */
  contentPageCommits: defineTable({
    jobId: v.id("contentGenerationJobs"),
    pageKey: v.string(),
    /** Saved concept lets a resumed job resolve links after page imports. */
    conceptId: v.optional(v.id("concepts")),
    payloadHash: v.string(),
    createdAt: v.number(),
  }).index("by_job_page", ["jobId", "pageKey"]),

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
    /** Denormalized label avoids reading the large source body during retrieval. */
    sourceFilename: v.optional(v.string()),
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
    /** `teach` marks a unit's Teach session; ordinary chats leave it unset. */
    purpose: v.optional(v.literal("teach")),
    /** Unit taught by a Teach session. */
    unitId: v.optional(v.id("units")),
    /** Lesson outline the tutor proposed in its first Teach reply. */
    teachOutline: v.optional(
      v.object({
        title: v.string(),
        sections: v.array(v.object({ id: v.string(), title: v.string() })),
      })
    ),
    /** Zero-based index of the section being taught; the outline length once complete. */
    teachSectionIndex: v.optional(v.number()),
    /** Ids of the outline sections actually taught. */
    teachTaughtSectionIds: v.optional(v.array(v.string())),
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
    .index("by_archived_updatedAt", ["isArchived", "updatedAt"])
    .index("by_unit_updatedAt", ["unitId", "updatedAt"]),

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
    /**
     * Page-marked full text stored beside the original when `text` holds only
     * a preview, such as a textbook too long for the preview limit.
     */
    textKey: v.optional(v.string()),
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
