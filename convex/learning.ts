/**
 * Persists the bounded learning model and records server-scored study events.
 *
 * The legacy cards and attempts tables remain available to the prototype. This
 * module adds source-linked topics, concepts, learning items, and an event log
 * that can be projected into the portable feed selector.
 */

import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import { paginationOptsValidator } from "convex/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  answerOrderMatters,
  evaluateAnswer,
  isStructuredQuestionType,
  selectFeedItems,
  type AnswerInput,
  type ConceptReviewState,
  type FeedItem,
  type Question,
} from "../lib/learning/core"
import { answersEquivalent, replayReviewEvents } from "../lib/learning/replay"

/** Learning-item formats accepted by generation and persistence. */
const learningItemType = v.union(
  v.literal("explain"),
  v.literal("single-choice"),
  v.literal("multiple-answer"),
  v.literal("true-false")
)

/** Reports whether a project has any persisted learning items for its actions. */
export const hasLearningItems = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("learningItems")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .first()
    return item !== null
  },
})

/** Reads a project source passage for a learning-path citation. */
export const readSourceCitation = query({
  args: {
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    locator: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source || source.projectId !== args.projectId) return null
    const chunks = await ctx.db
      .query("sourceChunks")
      .withIndex("by_source_ordinal", (q) => q.eq("sourceId", source._id))
      .take(PROJECT_PATH_LIMIT)
    const locator = args.locator?.trim()
    const matchingChunk = locator
      ? chunks.find((chunk) =>
          chunk.references.some(
            (reference) =>
              reference.value === locator ||
              reference.label === locator ||
              `${reference.label} ${reference.value}` === locator
          )
        )
      : undefined
    const text = matchingChunk?.text ?? source.extractedText
    const citationText = matchingChunk?.text ?? source.extractedText
    const pageValue = matchingChunk?.references.find(
      (reference) => reference.kind === "page"
    )?.value
    const page = pageValue ? Number.parseInt(pageValue, 10) : undefined
    return {
      citation: {
        filename: source.filename,
        label: locator || (matchingChunk?.sectionTitle ?? "Source material"),
        text: citationText,
        ...(page && Number.isFinite(page) ? { page } : {}),
      },
      text,
      startOffset: 0,
      endOffset: citationText.length,
      snapshotOnly: false,
      fileUrl: source.relativeKey
        ? `/api/sources/file?projectId=${encodeURIComponent(source.projectId)}&sourceId=${encodeURIComponent(source._id)}&inline=1`
        : undefined,
      mimeType:
        source.mimeType ??
        (source.kind === "pdf" ? "application/pdf" : "text/plain"),
      originalUrl: source.originalUrl,
    }
  },
})

/** Maximum records read while composing one project learning path. */
const PROJECT_PATH_LIMIT = 2_000

/** Returns a source-grounded project path with question-answer progress. */
export const getProjectPath = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const [topics, concepts, items, sources, reviews] = await Promise.all([
      ctx.db
        .query("topics")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("asc")
        .take(PROJECT_PATH_LIMIT),
      ctx.db
        .query("concepts")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("asc")
        .take(PROJECT_PATH_LIMIT),
      ctx.db
        .query("learningItems")
        .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
        .filter((q) => q.eq(q.field("archivedAt"), undefined))
        .order("asc")
        .take(PROJECT_PATH_LIMIT),
      ctx.db
        .query("sources")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("asc")
        .take(PROJECT_PATH_LIMIT),
      ctx.db
        .query("conceptReviews")
        .withIndex("by_project_dueAt", (q) => q.eq("projectId", args.projectId))
        .take(PROJECT_PATH_LIMIT),
    ])
    const sourceLabels = new Map(
      sources.map((source) => [String(source._id), source.filename])
    )
    const reviewsByConcept = new Map(
      reviews.map((review) => [String(review.conceptId), review])
    )
    const legacyAnswerCounts = await Promise.all(
      reviews
        .filter((review) => review.answeredQuestionCount === undefined)
        .map(async (review) => {
          const events = await ctx.db
            .query("studyEvents")
            .withIndex("by_project_concept_occurredAt", (q) =>
              q
                .eq("projectId", args.projectId)
                .eq("conceptId", review.conceptId)
            )
            .collect()
          const answeredItems = new Set(
            events
              .filter((event) => event.eventType === "answer")
              .map((event) => String(event.itemId))
          )
          return [String(review.conceptId), answeredItems.size] as const
        })
    )
    const answeredCountsByConcept = new Map(legacyAnswerCounts)
    const itemsByConcept = new Map<string, typeof items>()
    for (const item of items) {
      const conceptId = String(item.conceptId)
      const current = itemsByConcept.get(conceptId) ?? []
      current.push(item)
      itemsByConcept.set(conceptId, current)
    }

    /** Converts one concept to safe cards and question-answer progress. */
    function conceptForPath(concept: (typeof concepts)[number]) {
      const conceptItems = itemsByConcept.get(String(concept._id)) ?? []
      const review = reviewsByConcept.get(String(concept._id))
      const questionItems = conceptItems.filter(
        (item) => item.type !== "explain"
      )
      const answeredQuestionCount = Math.min(
        questionItems.length,
        review?.answeredQuestionCount ??
          answeredCountsByConcept.get(String(concept._id)) ??
          0
      )
      // Completion measures question coverage; correctness only affects review scheduling.
      const completionStatus =
        questionItems.length === 0 ||
        answeredQuestionCount >= questionItems.length
          ? ("completed" as const)
          : answeredQuestionCount > 0
            ? ("practicing" as const)
            : ("new" as const)
      // Preserve the old wire status until previously released mobile clients age out.
      const status =
        (review?.consecutiveCorrect ?? 0) >= 2
          ? ("mastered" as const)
          : (review?.attemptCount ?? 0) > 0
            ? ("practicing" as const)
            : ("new" as const)
      const hasNewMaterial = Boolean(
        review && conceptItems.some((item) => (item.updatedAt ?? item.createdAt) > review.updatedAt)
      )
      return {
        id: String(concept._id),
        title: concept.title,
        status,
        completionStatus,
        answeredQuestionCount,
        questionCount: questionItems.length,
        hasNewMaterial,
        sourceLabels: concept.sourceIds
          .map((sourceId) => sourceLabels.get(String(sourceId)))
          .filter((label): label is string => Boolean(label)),
        sourceCitations: concept.sourceIds.flatMap((sourceId) => {
          const source = sources.find((item) => item._id === sourceId)
          return source
            ? [{ sourceId: String(sourceId), filename: source.filename }]
            : []
        }),
        items: conceptItems.map((item) => ({
          id: String(item._id),
          conceptId: String(item.conceptId),
          type: item.type,
          title: item.title,
          ...(item.type === "explain" ? { body: item.body } : {}),
          ...(item.type === "explain" && item.deepExplanation
            ? { deepExplanation: item.deepExplanation }
            : {}),
          ...(item.type !== "explain" ? { question: item.question ?? "" } : {}),
          ...(item.options ? { options: item.options } : {}),
          sourceLabels: item.sourceReferences?.length
            ? item.sourceReferences
                .map((reference) => {
                  const filename = sourceLabels.get(String(reference.sourceId))
                  return filename ? `${filename}, ${reference.locator}` : undefined
                })
                .filter((label): label is string => Boolean(label))
            : item.sourceIds
                .map((sourceId) => sourceLabels.get(String(sourceId)))
                .filter((label): label is string => Boolean(label)),
          sourceCitations: item.sourceReferences?.length
            ? item.sourceReferences.flatMap((reference) => {
                const source = sources.find(
                  (candidate) => candidate._id === reference.sourceId
                )
                return source
                  ? [{
                      sourceId: String(reference.sourceId),
                      filename: source.filename,
                      locator: reference.locator,
                    }]
                  : []
              })
            : item.sourceIds.flatMap((sourceId) => {
                const source = sources.find((candidate) => candidate._id === sourceId)
                return source
                  ? [{ sourceId: String(sourceId), filename: source.filename }]
                  : []
              }),
        })),
      }
    }

    const conceptsByTopic = new Map<string, typeof concepts>()
    for (const concept of concepts) {
      const topicId = concept.topicId ? String(concept.topicId) : "unassigned"
      const current = conceptsByTopic.get(topicId) ?? []
      current.push(concept)
      conceptsByTopic.set(topicId, current)
    }
    const orderedTopics: Array<{ id: string; title: string }> = topics.map(
      (topic) => ({ id: String(topic._id), title: topic.title })
    )
    if (conceptsByTopic.has("unassigned")) {
      orderedTopics.push({ id: "unassigned", title: "Other material" })
    }
    const sections = orderedTopics
      .map((topic) => {
        const sectionConcepts = (conceptsByTopic.get(topic.id) ?? []).map(
          conceptForPath
        )
        return {
          id: topic.id,
          title: topic.title,
          hasNewMaterial: sectionConcepts.some(
            (concept) => concept.hasNewMaterial
          ),
          completedConcepts: sectionConcepts.filter(
            (concept) => concept.completionStatus === "completed"
          ).length,
          // Keep the old field while previously released mobile clients still read it.
          masteredConcepts: sectionConcepts.filter(
            (concept) => concept.status === "mastered"
          ).length,
          concepts: sectionConcepts,
        }
      })
      .filter((section) => section.concepts.length > 0)
    const allConcepts = sections.flatMap((section) => section.concepts)
    const completedConceptCount = allConcepts.filter(
      (concept) => concept.completionStatus === "completed"
    ).length
    const masteredConceptCount = allConcepts.filter(
      (concept) => concept.status === "mastered"
    ).length
    return {
      sections,
      stats: {
        sectionCount: sections.length,
        conceptCount: allConcepts.length,
        answeredQuestionCount: allConcepts.reduce(
          (total, concept) => total + concept.answeredQuestionCount,
          0
        ),
        completedConceptCount,
        // Keep the old field while previously released mobile clients still read it.
        masteredConceptCount,
        questionCount: allConcepts.reduce(
          (total, concept) =>
            total +
            concept.items.filter((item) => item.type !== "explain").length,
          0
        ),
      },
      isTruncated:
        topics.length === PROJECT_PATH_LIMIT ||
        concepts.length === PROJECT_PATH_LIMIT ||
        items.length === PROJECT_PATH_LIMIT,
    }
  },
})

/** Choice option payload accepted by learning-item insertion. */
const option = v.object({ id: v.string(), text: v.string() })

/** Input shape for one bounded generated learning item. */
const learningItemInput = v.object({
  conceptId: v.id("concepts"),
  sourceIds: v.array(v.id("sources")),
  type: learningItemType,
  title: v.string(),
  body: v.string(),
  deepExplanation: v.optional(v.string()),
  question: v.optional(v.string()),
  options: v.optional(v.array(option)),
  correctOptionId: v.optional(v.string()),
  correctOptionIds: v.optional(v.array(v.string())),
  correctAnswer: v.optional(v.boolean()),
  order: v.number(),
})

/** Scalar answer values accepted by the event mutation. */
const answer = v.union(v.string(), v.boolean(), v.array(v.string()))

/** How sure the learner was; see `AnswerConfidence` in `lib/learning/fsrs.ts`. */
const answerConfidence = v.union(v.literal("sure"), v.literal("guess"))

/** Maximum clock skew accepted for an offline device timestamp. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/** Maximum rows scanned by one unfiltered feed request across its project page. */
const FEED_SCAN_LIMIT = 200

/** Maximum projects advanced together so one feed page can mix project material. */
const FEED_PROJECT_PAGE_SIZE = 20

/** Serializable continuation state for the bounded multi-project feed scan. */
type LearningFeedCursor = {
  version: 3
  projectCursor: string | null
  projectIds: string[]
  itemAnchors: Array<number | null>
  itemDone: boolean[]
  recentConceptIds: string[]
  previousConceptId: string | null
}

/** Read-only context shared by query and mutation helpers. */
type ReadContext = Pick<QueryCtx, "db">

/** Write context used by the event and summary upserts. */
type WriteContext = Pick<MutationCtx, "db">

/** Checks a bounded text field and returns its trimmed form. */
function boundedText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > maximum) throw new Error(`${label} is too long`)
  return trimmed
}

/** Rejects non-finite or negative values used as client event timestamps. */
function validOccurredAt(value: number, now: number): void {
  if (!Number.isFinite(value) || value < 0 || value > now + MAX_FUTURE_SKEW_MS)
    throw new Error("Event timestamp must be a finite non-negative number")
}

/** Confirms that a project exists before a learning mutation proceeds. */
async function requireProject(
  ctx: ReadContext,
  projectId: Id<"projects">
): Promise<void> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
}

/** Confirms ownership of every source and rejects duplicate references. */
async function requireProjectSources(
  ctx: ReadContext,
  projectId: Id<"projects">,
  sourceIds: readonly Id<"sources">[]
): Promise<void> {
  if (!sourceIds.length) throw new Error("At least one source is required")
  if (new Set(sourceIds).size !== sourceIds.length)
    throw new Error("Source references must be unique")
  for (const sourceId of sourceIds) {
    const source = await ctx.db.get(sourceId)
    if (!source || source.projectId !== projectId)
      throw new Error("Source does not belong to project")
  }
}

/** Confirms a topic belongs to the project when one is supplied. */
async function requireProjectTopic(
  ctx: ReadContext,
  projectId: Id<"projects">,
  topicId: Id<"topics"> | undefined
): Promise<void> {
  if (topicId) {
    const topic = await ctx.db.get(topicId)
    if (!topic || topic.projectId !== projectId)
      throw new Error("Topic does not belong to project")
  }
}

/** Validates the stored shape of a generated item before persistence. */
function validateLearningItem(item: {
  type: "explain" | "single-choice" | "multiple-answer" | "true-false"
  title: string
  body: string
  deepExplanation?: string
  question?: string
  options?: readonly { id: string; text: string }[]
  correctOptionId?: string
  correctOptionIds?: readonly string[]
  correctAnswer?: boolean
  order: number
}): void {
  boundedText(item.title, "Learning item title", 180)
  boundedText(item.body, "Learning item body", 4_000)
  if (item.deepExplanation !== undefined)
    boundedText(item.deepExplanation, "Learning item deep explanation", 8_000)
  if (!Number.isSafeInteger(item.order) || item.order < 0)
    throw new Error("Learning item order is invalid")
  if (item.type === "explain") {
    if (
      item.deepExplanation === undefined ||
      item.question !== undefined ||
      item.options !== undefined ||
      item.correctOptionId !== undefined ||
      item.correctOptionIds !== undefined ||
      item.correctAnswer !== undefined
    )
      throw new Error("Explain items cannot contain answer fields")
    return
  }
  if (item.deepExplanation !== undefined)
    throw new Error("Question items cannot contain deep explanations")
  boundedText(item.question ?? "", "Question", 500)
  if (item.type === "true-false") {
    if (
      item.options !== undefined ||
      item.correctOptionId !== undefined ||
      item.correctOptionIds !== undefined ||
      item.correctAnswer === undefined
    )
      throw new Error("True-false items require only a boolean answer")
    return
  }
  if (
    !item.options ||
    item.options.length < 2 ||
    item.options.length > 8 ||
    item.options.some(
      (entry) =>
        !entry.id.trim() || !entry.text.trim() || entry.text.trim().length > 300
    ) ||
    new Set(item.options.map((entry) => entry.id.trim())).size !==
      item.options.length
  )
    throw new Error("Choice items require unique bounded options")
  const optionIds = new Set(item.options.map((entry) => entry.id.trim()))
  if (item.type === "single-choice") {
    if (
      !item.correctOptionId ||
      !optionIds.has(item.correctOptionId.trim()) ||
      item.correctOptionIds !== undefined ||
      item.correctAnswer !== undefined
    )
      throw new Error("Single-choice items require one valid correct option")
    return
  }
  if (
    !item.correctOptionIds ||
    !item.correctOptionIds.length ||
    new Set(item.correctOptionIds.map((id) => id.trim())).size !==
      item.correctOptionIds.length ||
    item.correctOptionIds.some((id) => !optionIds.has(id.trim())) ||
    item.correctOptionId !== undefined ||
    item.correctAnswer !== undefined
  )
    throw new Error("Multiple-answer items require a valid exact answer set")
}

/** Creates a core question from an item whose answer fields are server-owned. */
function questionFromItem(item: Doc<"learningItems">): Question {
  const base = {
    id: String(item._id),
    conceptId: String(item.conceptId),
    prompt: item.question ?? "",
    context: "feed" as const,
  }
  if (item.type === "single-choice")
    return {
      ...base,
      type: "single-choice",
      options: item.options ?? [],
      correctOptionId: item.correctOptionId ?? "",
    }
  if (item.type === "multiple-answer")
    return {
      ...base,
      type: "multiple-answer",
      options: item.options ?? [],
      correctOptionIds: item.correctOptionIds ?? [],
    }
  if (item.type === "true-false")
    return {
      ...base,
      type: "true-false",
      correctAnswer: item.correctAnswer ?? false,
    }
  if (item.type === "cloze")
    return { ...base, type: "cloze", acceptedAnswers: item.acceptedAnswers ?? [] }
  if (item.type === "code-output")
    return {
      ...base,
      type: "code-output",
      acceptedOutputs: item.acceptedAnswers?.[0] ?? [],
    }
  if (item.type === "ordering")
    return {
      ...base,
      type: "ordering",
      options: item.options ?? [],
      correctOrder: item.correctOptionIds ?? [],
    }
  if (item.type === "matching")
    return {
      ...base,
      type: "matching",
      prompts: item.matchPrompts ?? [],
      options: item.options ?? [],
      correctOptionIds: item.correctOptionIds ?? [],
    }
  throw new Error("Explain items cannot receive answers")
}

/** Finds an existing event for an idempotency key. */
async function findEvent(
  ctx: ReadContext,
  projectId: Id<"projects">,
  clientEventId: string
): Promise<Doc<"studyEvents"> | null> {
  const events = await ctx.db
    .query("studyEvents")
    .withIndex("by_project_clientEventId", (q) =>
      q.eq("projectId", projectId).eq("clientEventId", clientEventId)
    )
    .collect()
  return events[0] ?? null
}

/** Rebuilds answer scheduling and distinct answered-question counts from events. */
async function recomputeReview(
  ctx: ReadContext,
  projectId: Id<"projects">,
  conceptId: Id<"concepts">,
  now: number
): Promise<{
  review: ConceptReviewState
  answeredQuestionCount: number
}> {
  const events = await ctx.db
    .query("studyEvents")
    .withIndex("by_project_concept_occurredAt", (q) =>
      q.eq("projectId", projectId).eq("conceptId", conceptId)
    )
    .collect()
  const scored = events.filter(
    (
      event: Doc<"studyEvents">
    ): event is Doc<"studyEvents"> & {
      outcome: "correct" | "incorrect"
    } => event.eventType === "answer" && event.outcome !== undefined
  )
  return {
    review: replayReviewEvents(
      String(conceptId),
      scored.map((event) => ({
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        eventId: String(event._id),
        outcome: event.outcome,
        ...(event.confidence ? { confidence: event.confidence } : {}),
      })),
      now
    ),
    answeredQuestionCount: new Set(scored.map((event) => String(event.itemId)))
      .size,
  }
}

/** Converts a persisted review row into the portable core state shape. */
function reviewStateFromDoc(
  review: Doc<"conceptReviews"> | null
): ConceptReviewState | null {
  if (!review) return null
  return {
    conceptId: String(review.conceptId),
    attemptCount: review.attemptCount,
    correctCount: review.correctCount,
    incorrectCount: review.incorrectCount,
    consecutiveCorrect: review.consecutiveCorrect,
    lastAttemptAt: review.lastAttemptAt ?? null,
    dueAt: review.dueAt,
    lastOutcome: review.lastOutcome ?? null,
    memory: review.memory ?? null,
  }
}

/** Returns post-answer explanation and server-owned answer keys for feedback. */
function answerFeedbackForItem(item: Doc<"learningItems">) {
  return {
    body: item.body,
    ...(item.correctOptionId ? { correctOptionId: item.correctOptionId } : {}),
    ...(item.correctOptionIds
      ? { correctOptionIds: item.correctOptionIds }
      : {}),
    ...(item.correctAnswer !== undefined
      ? { correctAnswer: item.correctAnswer }
      : {}),
    ...(item.acceptedAnswers ? { acceptedAnswers: item.acceptedAnswers } : {}),
  }
}

/** Parses a bounded feed cursor and rejects tampered project or page state. */
function parseLearningFeedCursor(
  value: string | undefined,
  expectedProjectId?: Id<"projects">
): LearningFeedCursor | null {
  if (!value) return null
  if (value.length > 16_000) throw new Error("Feed cursor is too large")
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Feed cursor is invalid")
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Feed cursor is invalid")
  const cursor = parsed as Partial<LearningFeedCursor>
  if (
    cursor.version !== 3 ||
    !Array.isArray(cursor.projectIds) ||
    !Array.isArray(cursor.itemAnchors) ||
    cursor.projectIds.length !== cursor.itemAnchors.length ||
    (cursor.itemDone !== undefined &&
      (!Array.isArray(cursor.itemDone) ||
        cursor.projectIds.length !== cursor.itemDone.length)) ||
    cursor.projectIds.length > FEED_PROJECT_PAGE_SIZE ||
    (cursor.projectCursor !== null && typeof cursor.projectCursor !== "string")
  )
    throw new Error("Feed cursor is invalid")
  if (
    cursor.projectIds.some(
      (projectId) =>
        typeof projectId !== "string" ||
        !projectId.trim() ||
        projectId.length > 128
    ) ||
    cursor.itemAnchors.some(
      (itemAnchor) =>
        itemAnchor !== null &&
        (typeof itemAnchor !== "number" ||
          !Number.isFinite(itemAnchor) ||
          itemAnchor < 0)
    ) ||
    (cursor.itemDone !== undefined &&
      cursor.itemDone.some((done) => typeof done !== "boolean")) ||
    (cursor.recentConceptIds !== undefined &&
      (!Array.isArray(cursor.recentConceptIds) ||
        cursor.recentConceptIds.length > 64 ||
        cursor.recentConceptIds.some(
          (conceptId) =>
            typeof conceptId !== "string" ||
            !conceptId.trim() ||
            conceptId.length > 128
        ))) ||
    (cursor.previousConceptId !== undefined &&
      cursor.previousConceptId !== null &&
      (typeof cursor.previousConceptId !== "string" ||
        !cursor.previousConceptId.trim() ||
        cursor.previousConceptId.length > 128))
  )
    throw new Error("Feed cursor is invalid")
  if (expectedProjectId && cursor.projectIds.length !== 1) {
    throw new Error("Feed cursor does not match the project filter")
  }
  if (expectedProjectId && cursor.projectIds[0] !== String(expectedProjectId))
    throw new Error("Feed cursor does not match the project filter")
  return {
    version: 3,
    projectCursor: cursor.projectCursor ?? null,
    projectIds: [...cursor.projectIds],
    itemAnchors: [...cursor.itemAnchors],
    itemDone: cursor.itemDone
      ? [...cursor.itemDone]
      : cursor.itemAnchors.map(() => false),
    recentConceptIds: [...(cursor.recentConceptIds ?? [])],
    previousConceptId: cursor.previousConceptId ?? null,
  }
}

/** Creates the next opaque cursor only while more rows or projects remain. */
function nextLearningFeedCursor(
  projectCursor: string | null,
  projectIds: readonly string[],
  itemAnchors: readonly (number | null)[],
  itemDone: readonly boolean[],
  recentConceptIds: readonly string[],
  previousConceptId: string | null
): string | null {
  const hasMoreItems = itemDone.some((done) => !done)
  if (!hasMoreItems && projectCursor === null) return null
  return JSON.stringify({
    version: 3,
    projectCursor,
    projectIds: [...projectIds],
    itemAnchors: [...itemAnchors],
    itemDone: [...itemDone],
    recentConceptIds: [...recentConceptIds].slice(-64),
    previousConceptId,
  } satisfies LearningFeedCursor)
}

/** Writes recomputed answer progress and review summaries for one concept. */
async function saveReview(
  ctx: WriteContext,
  projectId: Id<"projects">,
  conceptId: Id<"concepts">,
  state: ConceptReviewState,
  answeredQuestionCount: number,
  updatedAt: number
): Promise<Id<"conceptReviews">> {
  const existing = await ctx.db
    .query("conceptReviews")
    .withIndex("by_project_concept", (q) =>
      q.eq("projectId", projectId).eq("conceptId", conceptId)
    )
    .collect()
  const value = {
    projectId,
    conceptId,
    answeredQuestionCount,
    attemptCount: state.attemptCount,
    correctCount: state.correctCount,
    incorrectCount: state.incorrectCount,
    consecutiveCorrect: state.consecutiveCorrect,
    ...(state.lastAttemptAt === null
      ? {}
      : { lastAttemptAt: state.lastAttemptAt }),
    dueAt: state.dueAt,
    ...(state.lastOutcome === null ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.memory ? { memory: state.memory } : {}),
    updatedAt,
  }
  if (existing[0]) {
    await ctx.db.patch(existing[0]._id, value)
    return existing[0]._id
  }
  return ctx.db.insert("conceptReviews", value)
}

/** Creates a topic after validating its project and optional parent topic. */
export const createTopic = mutation({
  args: {
    projectId: v.id("projects"),
    parentTopicId: v.optional(v.id("topics")),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    await requireProjectTopic(ctx, args.projectId, args.parentTopicId)
    const title = boundedText(args.title, "Topic title", 180)
    return ctx.db.insert("topics", {
      projectId: args.projectId,
      ...(args.parentTopicId ? { parentTopicId: args.parentTopicId } : {}),
      title,
      createdAt: Date.now(),
    })
  },
})

/** Creates a source-linked concept inside a project and optional topic. */
export const createConcept = mutation({
  args: {
    projectId: v.id("projects"),
    topicId: v.optional(v.id("topics")),
    title: v.string(),
    sourceIds: v.array(v.id("sources")),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    await requireProjectTopic(ctx, args.projectId, args.topicId)
    await requireProjectSources(ctx, args.projectId, args.sourceIds)
    return ctx.db.insert("concepts", {
      projectId: args.projectId,
      ...(args.topicId ? { topicId: args.topicId } : {}),
      title: boundedText(args.title, "Concept title", 180),
      sourceIds: args.sourceIds,
      createdAt: Date.now(),
    })
  },
})

/** Inserts a bounded generated batch after validating all cross-project references. */
export const insertLearningItems = mutation({
  args: { projectId: v.id("projects"), items: v.array(learningItemInput) },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    if (!args.items.length || args.items.length > 100)
      throw new Error("Learning item batches must contain 1 to 100 items")
    const orders = new Set<number>()
    const ids: Id<"learningItems">[] = []
    for (const item of args.items) {
      validateLearningItem(item)
      if (orders.has(item.order))
        throw new Error("Learning item orders must be unique")
      orders.add(item.order)
      const concept = await ctx.db.get(item.conceptId)
      if (!concept || concept.projectId !== args.projectId)
        throw new Error("Concept does not belong to project")
      await requireProjectSources(ctx, args.projectId, item.sourceIds)
      if (
        item.sourceIds.some((sourceId) => !concept.sourceIds.includes(sourceId))
      )
        throw new Error("Learning item source is not attached to its concept")
      ids.push(
        await ctx.db.insert("learningItems", {
          projectId: args.projectId,
          conceptId: item.conceptId,
          sourceIds: item.sourceIds,
          type: item.type,
          title: item.title.trim(),
          body: item.body.trim(),
          ...(item.deepExplanation
            ? { deepExplanation: item.deepExplanation.trim() }
            : {}),
          ...(item.question ? { question: item.question.trim() } : {}),
          ...(item.options
            ? {
                options: item.options.map((entry) => ({
                  id: entry.id.trim(),
                  text: entry.text.trim(),
                })),
              }
            : {}),
          ...(item.correctOptionId
            ? { correctOptionId: item.correctOptionId.trim() }
            : {}),
          ...(item.correctOptionIds
            ? { correctOptionIds: item.correctOptionIds.map((id) => id.trim()) }
            : {}),
          ...(item.correctAnswer !== undefined
            ? { correctAnswer: item.correctAnswer }
            : {}),
          order: item.order,
          createdAt: Date.now(),
        })
      )
    }
    return ids
  },
})

/** Returns mixed feed candidates with answers removed from client-facing data. */
export const listLearningFeedCandidates = query({
  args: {
    projectId: v.id("projects"),
    topicIds: v.optional(v.array(v.id("topics"))),
    limit: v.optional(v.number()),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const limit =
      args.limit === undefined
        ? 100
        : Math.min(Math.max(Math.floor(args.limit), 0), 100)
    const topicIds = args.topicIds?.length ? new Set(args.topicIds) : undefined
    if (
      args.limit !== undefined &&
      (!Number.isFinite(args.limit) || args.limit < 0)
    )
      throw new Error("Feed limit must be finite and non-negative")
    if (
      args.paginationOpts &&
      (!Number.isSafeInteger(args.paginationOpts.numItems) ||
        args.paginationOpts.numItems < 1 ||
        args.paginationOpts.numItems > 200)
    )
      throw new Error("Feed pages must contain 1 to 200 scanned items")
    if (limit === 0)
      return {
        items: [],
        isDone: true,
        continueCursor: args.paginationOpts?.cursor ?? null,
      }
    const itemsQuery = ctx.db
      .query("learningItems")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .order("asc")
    // Scan no more rows than can be returned, so advancing the cursor never
    // discards matching items at the end of a larger database page.
    const page = await itemsQuery.paginate({
      ...args.paginationOpts,
      numItems: Math.min(limit, args.paginationOpts?.numItems ?? limit),
      cursor: args.paginationOpts?.cursor ?? null,
    })
    const items = page.page
    const candidates = []
    for (const item of items) {
      if (item.archivedAt) continue
      const concept = await ctx.db.get(item.conceptId)
      if (
        !concept ||
        (topicIds && (!concept.topicId || !topicIds.has(concept.topicId)))
      )
        continue
      // Exclusion changes the mixed feed, while explicit topic study stays available.
      if (!topicIds && concept.topicId) {
        const topic = await ctx.db.get(concept.topicId)
        if (topic?.excludedFromFeed) continue
      }
      const reviews = await ctx.db
        .query("conceptReviews")
        .withIndex("by_project_concept", (q) =>
          q.eq("projectId", args.projectId).eq("conceptId", item.conceptId)
        )
        .collect()
      const review = reviews[0]
      const base = {
        id: String(item._id),
        projectId: item.projectId,
        topicId: concept.topicId ? String(concept.topicId) : undefined,
        conceptId: String(item.conceptId),
        format: item.type === "explain" ? "explanation" : "question",
        itemType: item.type,
        title: item.title,
        body: item.type === "explain" ? item.body : undefined,
        question: item.question,
        options: item.options,
        sourceIds: item.sourceIds.map(String),
        createdAt: item.createdAt,
        order: item.order,
      }
      candidates.push(
        review
          ? {
              ...base,
              kind: "review" as const,
              reviewState: {
                conceptId: String(review.conceptId),
                attemptCount: review.attemptCount,
                correctCount: review.correctCount,
                incorrectCount: review.incorrectCount,
                consecutiveCorrect: review.consecutiveCorrect,
                lastAttemptAt: review.lastAttemptAt ?? null,
                dueAt: review.dueAt,
                lastOutcome: review.lastOutcome ?? null,
              },
            }
          : { ...base, kind: "new" as const }
      )
    }
    return {
      items: candidates,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

/** Returns a bounded question-only due/new feed with source filenames and filters. */
export const getLearningFeed = query({
  args: {
    projectId: v.optional(v.id("projects")),
    topicId: v.optional(v.id("topics")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
      throw new Error("Feed limit must be between 1 and 30")

    const requestedTopic = args.topicId ? await ctx.db.get(args.topicId) : null
    if (args.topicId && !requestedTopic) throw new Error("Topic not found")
    if (
      args.projectId &&
      requestedTopic &&
      requestedTopic.projectId !== args.projectId
    )
      throw new Error("Topic does not belong to project")

    const requestedProject = args.projectId
      ? await ctx.db.get(args.projectId)
      : requestedTopic
        ? await ctx.db.get(requestedTopic.projectId)
        : null
    if ((args.projectId || requestedTopic) && !requestedProject)
      throw new Error("Project not found")

    const isProjectScoped = Boolean(args.projectId || requestedTopic)
    const suppliedCursor = parseLearningFeedCursor(
      args.cursor,
      requestedProject?._id
    )
    let projectCursor = suppliedCursor?.projectCursor ?? null
    let projectIds = suppliedCursor?.projectIds ?? []
    let itemAnchors = suppliedCursor?.itemAnchors ?? []
    let itemDone = suppliedCursor?.itemDone ?? []
    let recentConceptIds = suppliedCursor?.recentConceptIds ?? []
    let previousConceptId = suppliedCursor?.previousConceptId ?? null
    let selectedProjects: Array<Doc<"projects">> = []

    if (isProjectScoped) {
      const scopedProjectId = String(requestedProject?._id)
      if (!suppliedCursor) {
        projectIds = [scopedProjectId]
        itemAnchors = [null]
        itemDone = [false]
      }
      if (requestedProject) selectedProjects = [requestedProject]
    } else if (!suppliedCursor) {
      const page = await ctx.db
        .query("projects")
        .withIndex("by_createdAt")
        .order("desc")
        .paginate({ numItems: FEED_PROJECT_PAGE_SIZE, cursor: null })
      projectIds = page.page.map((project) => String(project._id))
      itemAnchors = page.page.map(() => null)
      itemDone = page.page.map(() => false)
      projectCursor = page.isDone ? null : page.continueCursor
      selectedProjects = page.page
    } else {
      const loadedProjects = await Promise.all(
        projectIds.map((projectId) => ctx.db.get(projectId as Id<"projects">))
      )
      if (loadedProjects.some((project) => !project))
        throw new Error("Feed cursor is invalid")
      selectedProjects = loadedProjects.filter(
        (project): project is Doc<"projects"> => Boolean(project)
      )
      if (itemDone.every((done) => done) && projectCursor !== null) {
        const page = await ctx.db
          .query("projects")
          .withIndex("by_createdAt")
          .order("desc")
          .paginate({
            numItems: FEED_PROJECT_PAGE_SIZE,
            cursor: projectCursor,
          })
        projectIds = page.page.map((project) => String(project._id))
        itemAnchors = page.page.map(() => null)
        itemDone = page.page.map(() => false)
        projectCursor = page.isDone ? null : page.continueCursor
        selectedProjects = page.page
      }
    }

    const topics = await ctx.db.query("topics").take(FEED_SCAN_LIMIT)
    const visibleProjectId = args.projectId ?? requestedTopic?.projectId
    const visibleTopics = topics
      .filter(
        (topic) => !visibleProjectId || topic.projectId === visibleProjectId
      )
      .map((topic) => ({
        id: String(topic._id),
        projectId: String(topic.projectId),
        title: topic.title,
      }))
    const activeProjectIndices = selectedProjects
      .map((_, index) => index)
      .filter((index) => !itemDone[index])
    const scanBase = Math.floor(
      limit / Math.max(1, activeProjectIndices.length)
    )
    const scanRemainder = limit % Math.max(1, activeProjectIndices.length)
    const scanCountByProject = new Map(
      activeProjectIndices.map((projectIndex, activeIndex) => [
        projectIndex,
        scanBase + (activeIndex < scanRemainder ? 1 : 0),
      ])
    )
    const now = Date.now()
    const reviewCache = new Map<string, Doc<"conceptReviews"> | null>()
    const candidateItems: FeedItem[] = []
    const cardById = new Map<
      string,
      {
        id: string
        projectId: string
        conceptId: string
        topicId?: string
        type: "single-choice" | "multiple-answer" | "true-false"
        title: string
        question: string
        options?: { id: string; text: string }[]
        sourceLabel: string
        sourceIds: string[]
      }
    >()
    const nextItemAnchors = [...itemAnchors]
    const nextItemDone = [...itemDone]

    for (const [projectIndex, project] of selectedProjects.entries()) {
      const scanCount = scanCountByProject.get(projectIndex) ?? 0
      if (scanCount === 0 || itemDone[projectIndex]) continue
      const itemAnchor = itemAnchors[projectIndex]
      // Home is reserved for retrieval practice. Explanation items remain in
      // project walkthroughs, where their place in the path is visible.
      const page = await ctx.db
        .query("learningItems")
        .withIndex("by_project", (q) =>
          itemAnchor === null || itemAnchor === undefined
            ? q.eq("projectId", project._id)
            : q.eq("projectId", project._id).gt("_creationTime", itemAnchor)
        )
        .filter((q) => q.neq(q.field("type"), "explain"))
        .order("asc")
        .take(scanCount + 1)
      const itemPage = page.slice(0, scanCount)
      // Source-local order repeats across imports. Convex creation timestamps
      // provide the stable per-document index boundary used for continuation.
      nextItemAnchors[projectIndex] = itemPage.at(-1)?._creationTime ?? null
      nextItemDone[projectIndex] = page.length <= scanCount
      for (const item of itemPage) {
        // This feed's cards only carry choice questions, so structured ones stay in drills.
        if (item.type === "explain" || item.archivedAt || isStructuredQuestionType(item.type))
          continue
        const concept = await ctx.db.get(item.conceptId)
        if (!concept) continue
        if (requestedTopic && concept.topicId !== requestedTopic._id) continue
        if (!requestedTopic && concept.topicId) {
          const topic = await ctx.db.get(concept.topicId)
          if (topic?.excludedFromFeed) continue
        }
        let review = reviewCache.get(String(item.conceptId))
        if (review === undefined) {
          const reviews = await ctx.db
            .query("conceptReviews")
            .withIndex("by_project_concept", (q) =>
              q.eq("projectId", project._id).eq("conceptId", item.conceptId)
            )
            .take(1)
          review = reviews[0] ?? null
          reviewCache.set(String(item.conceptId), review)
        }
        const feedItem: FeedItem = review
          ? {
              id: String(item._id),
              projectId: String(item.projectId),
              conceptId: String(item.conceptId),
              createdAt: item.createdAt,
              order: item.order,
              format: "question",
              ...(concept.topicId ? { topicId: String(concept.topicId) } : {}),
              kind: "review",
              reviewState: {
                conceptId: String(review.conceptId),
                attemptCount: review.attemptCount,
                correctCount: review.correctCount,
                incorrectCount: review.incorrectCount,
                consecutiveCorrect: review.consecutiveCorrect,
                lastAttemptAt: review.lastAttemptAt ?? null,
                dueAt: review.dueAt,
                lastOutcome: review.lastOutcome ?? null,
              },
            }
          : {
              id: String(item._id),
              projectId: String(item.projectId),
              conceptId: String(item.conceptId),
              createdAt: item.createdAt,
              order: item.order,
              format: "question",
              ...(concept.topicId ? { topicId: String(concept.topicId) } : {}),
              kind: "new",
            }
        candidateItems.push(feedItem)
        const sources = await Promise.all(
          item.sourceIds.map((sourceId) => ctx.db.get(sourceId))
        )
        const source = sources.find((candidate) => candidate !== null)
        if (!source) continue
        cardById.set(String(item._id), {
          id: String(item._id),
          projectId: String(item.projectId),
          conceptId: String(item.conceptId),
          ...(concept.topicId ? { topicId: String(concept.topicId) } : {}),
          type: item.type,
          title: item.title,
          question: item.question ?? "",
          ...(item.options ? { options: item.options } : {}),
          sourceLabel: source.filename,
          sourceIds: item.sourceIds.map(String),
        })
      }
    }

    const selected = selectFeedItems({
      items: candidateItems.filter((item) => cardById.has(item.id)),
      now,
      limit,
      ...(previousConceptId ? { previousConceptId } : {}),
      recentConceptIds,
      ...(args.projectId ? { projectId: String(args.projectId) } : {}),
      ...(args.topicId ? { topicId: String(args.topicId) } : {}),
    })
    const cards = selected.flatMap((item) => {
      const card = cardById.get(item.id)
      return card ? [card] : []
    })
    const projectOptions = isProjectScoped
      ? requestedProject
        ? [requestedProject]
        : []
      : selectedProjects

    if (isProjectScoped) projectCursor = null
    const selectedConceptIds = selected.map((item) => item.conceptId)
    recentConceptIds = [...recentConceptIds, ...selectedConceptIds].slice(-64)
    previousConceptId = selected.at(-1)?.conceptId ?? previousConceptId
    const continueCursor = nextLearningFeedCursor(
      projectCursor,
      projectIds,
      nextItemAnchors,
      nextItemDone,
      recentConceptIds,
      previousConceptId
    )
    return {
      cards,
      projects: projectOptions.map((project) => ({
        id: String(project._id),
        title: project.title,
      })),
      topics: visibleTopics,
      isDone: continueCursor === null,
      continueCursor,
    }
  },
})

/** Records a skip or exposure event without changing concept review state. */
export const recordPassiveEvent = mutation({
  args: {
    clientEventId: v.string(),
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    occurredAt: v.number(),
    eventType: v.union(v.literal("skip"), v.literal("exposure")),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const receivedAt = Date.now()
    validOccurredAt(args.occurredAt, receivedAt)
    const clientEventId = boundedText(
      args.clientEventId,
      "Client event id",
      200
    )
    const item = await ctx.db.get(args.itemId)
    if (!item || item.projectId !== args.projectId)
      throw new Error("Learning item does not belong to project")
    const existing = await findEvent(ctx, args.projectId, clientEventId)
    if (existing) {
      if (
        existing.itemId !== args.itemId ||
        existing.eventType !== args.eventType ||
        existing.occurredAt !== args.occurredAt
      )
        throw new Error("Client event id is already used for another event")
      return {
        eventId: existing._id,
        alreadyRecorded: true,
        eventType: existing.eventType,
      }
    }
    const eventId = await ctx.db.insert("studyEvents", {
      clientEventId,
      projectId: args.projectId,
      itemId: args.itemId,
      conceptId: item.conceptId,
      occurredAt: args.occurredAt,
      receivedAt,
      eventType: args.eventType,
    })
    return { eventId, alreadyRecorded: false, eventType: args.eventType }
  },
})

/** Scores an answer against stored item data, then records only valid scored events. */
export const recordAnswerEvent = mutation({
  args: {
    clientEventId: v.string(),
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    occurredAt: v.number(),
    answer,
    /** `guess` when the learner marked the answer as a guess before checking. */
    confidence: v.optional(answerConfidence),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const receivedAt = Date.now()
    validOccurredAt(args.occurredAt, receivedAt)
    const clientEventId = boundedText(
      args.clientEventId,
      "Client event id",
      200
    )
    const item = await ctx.db.get(args.itemId)
    if (!item || item.projectId !== args.projectId)
      throw new Error("Learning item does not belong to project")
    const existing = await findEvent(ctx, args.projectId, clientEventId)
    if (existing) {
      if (existing.itemId !== args.itemId || existing.eventType !== "answer")
        throw new Error("Client event id is already used for another event")
      if (
        existing.occurredAt !== args.occurredAt ||
        existing.answer === undefined ||
        !answersEquivalent(
          existing.answer as AnswerInput,
          args.answer as AnswerInput,
          answerOrderMatters(item.type)
        )
      )
        throw new Error("Client event id payload conflicts with stored event")
      if (existing.outcome === undefined)
        throw new Error("Stored answer event has no server outcome")
      const review = await ctx.db
        .query("conceptReviews")
        .withIndex("by_project_concept", (q) =>
          q.eq("projectId", args.projectId).eq("conceptId", item.conceptId)
        )
        .collect()
      return {
        status: existing.outcome,
        isCorrect: existing.outcome === "correct",
        eventId: existing._id,
        alreadyRecorded: true,
        review: reviewStateFromDoc(review[0] ?? null),
        feedback: answerFeedbackForItem(item),
      }
    }
    const evaluation = evaluateAnswer(
      questionFromItem(item),
      args.answer as AnswerInput
    )
    if (evaluation.status === "invalid")
      return {
        status: "invalid" as const,
        isCorrect: false,
        eventId: null,
        alreadyRecorded: false,
        review: null,
        reason: evaluation.reason,
      }
    const eventId = await ctx.db.insert("studyEvents", {
      clientEventId,
      projectId: args.projectId,
      itemId: args.itemId,
      conceptId: item.conceptId,
      occurredAt: args.occurredAt,
      receivedAt,
      eventType: "answer",
      answer: args.answer,
      outcome: evaluation.status,
      ...(args.confidence ? { confidence: args.confidence } : {}),
    })
    // Keep the latest outcome on the item, and mark its unit as started.
    if ((item.lastAnsweredAt ?? 0) <= args.occurredAt)
      await ctx.db.patch(item._id, {
        lastOutcome: evaluation.status,
        lastAnsweredAt: args.occurredAt,
      })
    if (item.unitId) {
      const unit = await ctx.db.get(item.unitId)
      if (unit && !unit.startedAt)
        await ctx.db.patch(unit._id, { startedAt: receivedAt })
    }
    const reviewProgress = await recomputeReview(
      ctx,
      args.projectId,
      item.conceptId,
      receivedAt
    )
    await saveReview(
      ctx,
      args.projectId,
      item.conceptId,
      reviewProgress.review,
      reviewProgress.answeredQuestionCount,
      receivedAt
    )
    return {
      status: evaluation.status,
      isCorrect: evaluation.isCorrect,
      eventId,
      alreadyRecorded: false,
      review: reviewProgress.review,
      feedback: answerFeedbackForItem(item),
    }
  },
})

/**
 * Records a self-graded recall attempt: the learner answered a question from
 * memory before seeing its options, then said whether they knew it. This is
 * the only answer whose outcome comes from the learner rather than the
 * server, which is why it is kept apart from `recordAnswerEvent` and marked
 * with `answerMode: "recall"`. It updates review scheduling like any answer.
 */
export const recordRecallEvent = mutation({
  args: {
    clientEventId: v.string(),
    projectId: v.id("projects"),
    itemId: v.id("learningItems"),
    occurredAt: v.number(),
    outcome: v.union(v.literal("correct"), v.literal("incorrect")),
  },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const receivedAt = Date.now()
    validOccurredAt(args.occurredAt, receivedAt)
    const clientEventId = boundedText(args.clientEventId, "Client event id", 200)
    const item = await ctx.db.get(args.itemId)
    if (!item || item.projectId !== args.projectId)
      throw new Error("Learning item does not belong to project")
    const existing = await findEvent(ctx, args.projectId, clientEventId)
    if (existing) {
      if (existing.itemId !== args.itemId || existing.answerMode !== "recall")
        throw new Error("Client event id is already used for another event")
      return { eventId: existing._id, alreadyRecorded: true }
    }
    const eventId = await ctx.db.insert("studyEvents", {
      clientEventId,
      projectId: args.projectId,
      itemId: args.itemId,
      conceptId: item.conceptId,
      occurredAt: args.occurredAt,
      receivedAt,
      eventType: "answer",
      outcome: args.outcome,
      answerMode: "recall",
    })
    if ((item.lastAnsweredAt ?? 0) <= args.occurredAt)
      await ctx.db.patch(item._id, {
        lastOutcome: args.outcome,
        lastAnsweredAt: args.occurredAt,
      })
    const reviewProgress = await recomputeReview(
      ctx,
      args.projectId,
      item.conceptId,
      receivedAt
    )
    await saveReview(
      ctx,
      args.projectId,
      item.conceptId,
      reviewProgress.review,
      reviewProgress.answeredQuestionCount,
      receivedAt
    )
    return { eventId, alreadyRecorded: false }
  },
})

/**
 * Returns the answer to a single-choice question so the learner can check an
 * answer recalled from memory. Records nothing; the learner's verdict goes
 * through `recordRecallEvent`. Other question types return null.
 */
export const revealAnswer = query({
  args: { projectId: v.id("projects"), itemId: v.id("learningItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId)
    if (!item || item.projectId !== args.projectId) return null
    if (item.type !== "single-choice" || !item.correctOptionId) return null
    const option = item.options?.find((entry) => entry.id === item.correctOptionId)
    if (!option) return null
    return { answer: option.text, body: item.body }
  },
})

/**
 * Re-runs every concept's review schedule from its answer log. Run once after
 * the switch to FSRS so concepts answered under the old fixed intervals get
 * FSRS due dates: `npx convex run learning:rescheduleReviews`. Safe to repeat;
 * a project is processed per call when the library is large.
 */
export const rescheduleReviews = internalMutation({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, args) => {
    const reviews = args.projectId
      ? await ctx.db
          .query("conceptReviews")
          .withIndex("by_project_concept", (q) => q.eq("projectId", args.projectId!))
          .collect()
      : await ctx.db.query("conceptReviews").collect()
    const now = Date.now()
    for (const review of reviews) {
      const progress = await recomputeReview(ctx, review.projectId, review.conceptId, now)
      await saveReview(
        ctx,
        review.projectId,
        review.conceptId,
        progress.review,
        progress.answeredQuestionCount,
        now
      )
    }
    return { rescheduled: reviews.length }
  },
})

/** Returns one persisted concept review summary for focused study views. */
export const getConceptReview = query({
  args: { projectId: v.id("projects"), conceptId: v.id("concepts") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId)
    const concept = await ctx.db.get(args.conceptId)
    if (!concept || concept.projectId !== args.projectId)
      throw new Error("Concept does not belong to project")
    const reviews = await ctx.db
      .query("conceptReviews")
      .withIndex("by_project_concept", (q) =>
        q.eq("projectId", args.projectId).eq("conceptId", args.conceptId)
      )
      .collect()
    return reviews[0] ?? null
  },
})
