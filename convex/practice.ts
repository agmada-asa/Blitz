/**
 * Owns exam practice data: each unit's question bank and the runs that write
 * it, the per-concept mastery overview, and the adaptive drill deck that asks
 * missed and weak material first.
 *
 * Questions are ordinary learning items (`origin: "bank"` for generated ones,
 * `"teach"` for lesson quizzes), so answers flow through
 * `learning.recordAnswerEvent` and update the same review state. Exam paper
 * questions (`origin: "exam"`, see `convex/exam.ts`) count toward concept
 * strength but are never drilled or shown in the feed, so a paper's answers
 * stay hidden until it is taken.
 */

import { v } from "convex/values"

import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { quizFields, quizFromItem, quizItemFields, quizValidator } from "./quizFields"
import {
  conceptStrength,
  selectDrillQuestions,
  type ConceptStrength,
  type DrillCandidate,
} from "../lib/drill"

/** A generation run older than this is treated as abandoned. */
const GENERATION_LEASE_MS = 10 * 60 * 1000

/** Characters of extracted text per source returned for a generation prompt. */
const MAX_GENERATION_SOURCE_TEXT = 300_000

/** Most questions a drill returns at once. */
const MAX_DRILL_QUESTIONS = 30

/** Question formats a drill can ask. */
const QUESTION_TYPES = new Set([
  "single-choice",
  "multiple-answer",
  "true-false",
  "cloze",
  "ordering",
  "matching",
  "code-output",
])

/** Normalises a concept title for matching. */
function conceptTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 120) || "General"
}

/**
 * Finds a concept by title within one unit, creating it when missing.
 * Concepts are per unit: a generic title in two weeks is two concepts.
 * @returns The concept document.
 */
async function unitConcept(
  ctx: Pick<MutationCtx, "db">,
  projectId: Id<"projects">,
  unitId: Id<"units">,
  name: string,
  sourceIds: Id<"sources">[],
  now: number
): Promise<Doc<"concepts">> {
  const title = conceptTitle(name)
  const existing = (
    await ctx.db
      .query("concepts")
      .withIndex("by_project_title", (q) => q.eq("projectId", projectId).eq("title", title))
      .collect()
  ).find((candidate) => candidate.unitId === unitId)
  if (existing) return existing
  const conceptId = await ctx.db.insert("concepts", {
    projectId,
    unitId,
    title,
    sourceIds,
    createdAt: now,
  })
  return (await ctx.db.get(conceptId))!
}

/** Returns whether a learning item is an answerable question. */
function isQuestion(item: Doc<"learningItems">): boolean {
  return QUESTION_TYPES.has(item.type) && !item.archivedAt && Boolean(item.question)
}

/** Returns whether a question may be drilled or shown in the feed; exam paper questions may not. */
function isPracticeQuestion(item: Doc<"learningItems">): boolean {
  return isQuestion(item) && item.origin !== "exam"
}

/** Loads every concept review in a project, keyed by concept. */
async function reviewsByConcept(ctx: Pick<QueryCtx, "db">, projectId: Id<"projects">) {
  const reviews = await ctx.db
    .query("conceptReviews")
    .withIndex("by_project_dueAt", (q) => q.eq("projectId", projectId))
    .collect()
  return new Map(reviews.map((review) => [String(review.conceptId), review]))
}

/** Converts a concept review into the history used for strength. */
function historyOf(review: Doc<"conceptReviews"> | undefined) {
  return {
    attempts: review?.attemptCount ?? 0,
    correct: review?.correctCount ?? 0,
    consecutiveCorrect: review?.consecutiveCorrect ?? 0,
    ...(review?.lastOutcome ? { lastOutcome: review.lastOutcome } : {}),
  }
}

/** Returns the latest answer to one question, if any. */
async function latestAnswer(ctx: Pick<QueryCtx, "db">, itemId: Id<"learningItems">) {
  return ctx.db
    .query("studyEvents")
    .withIndex("by_item_occurredAt", (q) => q.eq("itemId", itemId))
    .order("desc")
    .filter((q) => q.eq(q.field("eventType"), "answer"))
    .first()
}

/** Shapes a question item for the quiz renderer, including its answer key. */
function quizShape(item: Doc<"learningItems">) {
  return { kind: "quiz" as const, id: String(item._id), ...quizFromItem(item) }
}

/**
 * Shapes a learning item as a card in the shared feed contract
 * (`lib/learning/client-contracts.ts`). Question cards carry no answer key;
 * `learning.recordAnswerEvent` scores them and reveals the key.
 * @param item A question or explain item.
 * @param unitTitle Shown as the card's source label.
 * @param key Unique key within one session, when the same item can repeat.
 */
function feedCard(item: Doc<"learningItems">, unitTitle: string, key?: string) {
  const base = {
    id: String(item._id),
    ...(key ? { key } : {}),
    projectId: String(item.projectId),
    conceptId: String(item.conceptId),
    title: item.title,
    sourceLabel: unitTitle,
    sourceIds: item.sourceIds.map(String),
  }
  if (item.type === "explain") return { ...base, type: "explain" as const, body: item.body }
  return {
    ...base,
    type: item.type,
    question: item.question ?? "",
    ...(item.type === "true-false" || item.type === "cloze" || item.type === "code-output"
      ? {}
      : { options: item.options ?? [] }),
    // Matching cards need their left-hand items; the answer key stays on the server.
    ...(item.matchPrompts ? { prompts: item.matchPrompts } : {}),
  }
}

/**
 * Supplies the server route with what a question-bank prompt needs: the
 * unit's material, the sections taught so far, weak concepts, and existing
 * questions to avoid repeating. Server-only.
 */
export const generationContext = query({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const unit = await ctx.db.get(unitId)
    if (!unit) return null
    const project = await ctx.db.get(unit.projectId)
    if (!project) return null
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect()
    const chat = await ctx.db
      .query("workspaceChats")
      .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unitId))
      .order("desc")
      .first()
    const outline = chat?.teachOutline
    const taughtSections = outline
      ? outline.sections
          .slice(0, Math.min(outline.sections.length, (chat?.teachSectionIndex ?? 0) + 1))
          .map((section) => section.title)
      : []
    const items = (
      await ctx.db
        .query("learningItems")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()
    ).filter(isQuestion)
    const reviews = await reviewsByConcept(ctx, unit.projectId)
    const conceptIds = [...new Set(items.map((item) => item.conceptId))]
    const weakConcepts: string[] = []
    for (const conceptId of conceptIds) {
      if (conceptStrength(historyOf(reviews.get(String(conceptId)))) !== "weak") continue
      const concept = await ctx.db.get(conceptId)
      if (concept) weakConcepts.push(concept.title)
    }
    const existingConcepts = (
      await ctx.db
        .query("concepts")
        .withIndex("by_project", (q) => q.eq("projectId", unit.projectId))
        .collect()
    )
      .filter((concept) => concept.unitId === unitId)
      .map((concept) => concept.title)
    return {
      projectId: unit.projectId,
      existingConcepts,
      moduleTitle: project.title,
      unitTitle: unit.title,
      sources: sources
        .filter((source) => source.extractedText.trim())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((source) => ({
          filename: source.filename,
          text: source.extractedText.slice(0, MAX_GENERATION_SOURCE_TEXT),
        })),
      taughtSections,
      weakConcepts,
      outlineConcepts: outline?.sections.flatMap((section) => section.concepts ?? []) ?? [],
      existingQuestions: items.map((item) => item.question ?? "").filter(Boolean),
    }
  },
})

/**
 * Starts a question-bank run for a unit unless one is already running.
 * @returns The run ID, or `alreadyRunning` with the active run's ID.
 */
export const startGeneration = mutation({
  args: {
    unitId: v.id("units"),
    count: v.number(),
    /** Skip when the unit already has generated questions, for automatic first banks. */
    onlyIfEmpty: v.optional(v.boolean()),
  },
  handler: async (ctx, { unitId, count, onlyIfEmpty }) => {
    const unit = await ctx.db.get(unitId)
    if (!unit) throw new Error("Unit not found")
    if (onlyIfEmpty) {
      const existing = await ctx.db
        .query("questionGenerations")
        .withIndex("by_unit_startedAt", (q) => q.eq("unitId", unitId))
        .first()
      if (existing) return { generationId: existing._id, alreadyRunning: true, skipped: true }
    }
    const now = Date.now()
    const latest = await ctx.db
      .query("questionGenerations")
      .withIndex("by_unit_startedAt", (q) => q.eq("unitId", unitId))
      .order("desc")
      .first()
    if (latest?.status === "running" && latest.startedAt > now - GENERATION_LEASE_MS)
      return { generationId: latest._id, alreadyRunning: true, skipped: false }
    if (latest?.status === "running")
      await ctx.db.patch(latest._id, {
        status: "failed",
        error: "The previous run stopped before finishing.",
        finishedAt: now,
      })
    const generationId = await ctx.db.insert("questionGenerations", {
      projectId: unit.projectId,
      unitId,
      status: "running",
      requestedCount: Math.max(1, Math.min(30, Math.round(count))),
      createdCount: 0,
      startedAt: now,
    })
    return { generationId, alreadyRunning: false, skipped: false }
  },
})

/**
 * Saves validated questions from a run as learning items under their
 * concepts. Concepts are matched by title within the project.
 */
export const saveGeneratedQuestions = mutation({
  args: {
    generationId: v.id("questionGenerations"),
    questions: v.array(quizValidator),
    /** Short concept reminders shown in the feed; one per concept per unit. */
    recaps: v.optional(
      v.array(v.object({ concept: v.string(), title: v.string(), body: v.string() }))
    ),
    rejectedCount: v.number(),
  },
  handler: async (ctx, { generationId, questions, recaps, rejectedCount }) => {
    const run = await ctx.db.get(generationId)
    if (!run || run.status !== "running") throw new Error("Question run is not active")
    if (questions.length > 30) throw new Error("Too many questions")
    const sourceIds = (
      await ctx.db
        .query("sources")
        .withIndex("by_unit", (q) => q.eq("unitId", run.unitId))
        .collect()
    ).map((source) => source._id)
    const now = Date.now()
    /** Finds or creates this unit's concept with the given name. */
    const conceptFor = (name: string) =>
      unitConcept(ctx, run.projectId, run.unitId, name, sourceIds, now)
    const unitItems = await ctx.db
      .query("learningItems")
      .withIndex("by_unit", (q) => q.eq("unitId", run.unitId))
      .collect()
    for (const recap of (recaps ?? []).slice(0, 12)) {
      const concept = await conceptFor(recap.concept)
      if (unitItems.some((item) => item.type === "explain" && item.conceptId === concept._id))
        continue
      await ctx.db.insert("learningItems", {
        projectId: run.projectId,
        conceptId: concept._id,
        unitId: run.unitId,
        origin: "bank",
        sourceIds,
        type: "explain",
        title: recap.title.slice(0, 160),
        body: recap.body.slice(0, 1_500),
        order: now,
        createdAt: now,
      })
    }
    for (const [index, question] of questions.entries()) {
      const concept = await conceptFor(question.concept)
      const title = concept.title
      await ctx.db.insert("learningItems", {
        projectId: run.projectId,
        conceptId: concept._id,
        unitId: run.unitId,
        origin: "bank",
        sourceIds,
        title,
        ...quizItemFields(question),
        order: now + index,
        createdAt: now,
      })
    }
    await ctx.db.patch(generationId, {
      createdCount: run.createdCount + questions.length,
      rejectedCount: (run.rejectedCount ?? 0) + rejectedCount,
    })
  },
})

/**
 * Lists where quizzes in a chat can be saved: the chat's module units, the
 * unit to suggest first, and which quizzes are already saved, keyed by
 * message ID and then quiz ID. Returns null for chats outside a module.
 */
export const chatQuizTargets = query({
  args: { chatId: v.id("workspaceChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat?.projectId) return null
    const projectId = chat.projectId
    const units = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
      .collect()
    if (!units.length) return null
    // Suggest the chat's own unit, else the unit studied most recently, else the first.
    const latestStarted = [...units]
      .filter((unit) => unit.startedAt)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
    const defaultUnitId = chat.unitId ?? latestStarted?._id ?? units[0]._id
    const titles = new Map(units.map((unit) => [String(unit._id), unit.title]))
    const saved: Record<string, Record<string, { unitId: Id<"units">; unitTitle: string }>> = {}
    const messages = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chatId))
      .collect()
    for (const message of messages) {
      if (message.role !== "assistant" || !message.content.includes("```quiz")) continue
      // Keys are `<messageId>:<quizId>`, so one message's quizzes share a prefix.
      const items = await ctx.db
        .query("learningItems")
        .withIndex("by_project_teachKey", (q) =>
          q
            .eq("projectId", projectId)
            .gte("teachKey", `${message._id}:`)
            .lt("teachKey", `${message._id};`)
        )
        .collect()
      for (const item of items) {
        if (item.origin !== "chat" || !item.unitId || item.archivedAt) continue
        const quizId = item.teachKey!.slice(message._id.length + 1)
        saved[message._id] = {
          ...saved[message._id],
          [quizId]: { unitId: item.unitId, unitTitle: titles.get(String(item.unitId)) ?? "" },
        }
      }
    }
    return {
      projectId,
      defaultUnitId,
      units: units.map((unit) => ({ id: unit._id, title: unit.title })),
      saved,
    }
  },
})

/**
 * Saves one quiz from a finished chat reply into a unit's question bank, so
 * it is drilled and shown in the feed like generated questions. The server
 * route parses the quiz from the saved reply; saving the same quiz again
 * returns the existing question.
 * @returns The question's ID and whether it already existed.
 */
export const saveChatQuiz = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    unitId: v.id("units"),
    quiz: v.object({ id: v.string(), ...quizFields }),
  },
  handler: async (ctx, { chatId, messageId, unitId, quiz }) => {
    const chat = await ctx.db.get(chatId)
    const unit = await ctx.db.get(unitId)
    if (!chat?.projectId || !unit || unit.projectId !== chat.projectId)
      throw new Error("Choose a unit in this chat's module")
    const message = await ctx.db.get(messageId)
    if (
      !message ||
      message.chatId !== chatId ||
      message.role !== "assistant" ||
      message.status !== "completed"
    )
      throw new Error("Save questions after the reply finishes")
    const projectId = chat.projectId
    const teachKey = `${messageId}:${quiz.id}`
    const existing = await ctx.db
      .query("learningItems")
      .withIndex("by_project_teachKey", (q) =>
        q.eq("projectId", projectId).eq("teachKey", teachKey)
      )
      .first()
    if (existing && !existing.archivedAt) return { itemId: existing._id, alreadySaved: true }
    const sourceIds = (
      await ctx.db
        .query("sources")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()
    ).map((source) => source._id)
    const now = Date.now()
    const concept = await unitConcept(ctx, projectId, unitId, quiz.concept, sourceIds, now)
    const itemId = await ctx.db.insert("learningItems", {
      projectId,
      conceptId: concept._id,
      unitId,
      teachKey,
      origin: "chat",
      sourceIds,
      title: concept.title,
      ...quizItemFields(quiz),
      order: now,
      createdAt: now,
    })
    return { itemId, alreadySaved: false }
  },
})

/** Marks a run finished, with a learner-facing error when it failed. */
export const finishGeneration = mutation({
  args: { generationId: v.id("questionGenerations"), error: v.optional(v.string()) },
  handler: async (ctx, { generationId, error }) => {
    const run = await ctx.db.get(generationId)
    if (!run || run.status !== "running") return
    await ctx.db.patch(generationId, {
      status: error ? "failed" : "completed",
      ...(error ? { error: error.slice(0, 300) } : {}),
      finishedAt: Date.now(),
    })
  },
})

/** One concept's practice summary. */
type ConceptSummary = {
  id: Id<"concepts">
  title: string
  strength: ConceptStrength
  attempts: number
  accuracy: number | null
}

/**
 * Summarises practice for a module: per unit, its question count, answered
 * and correct counts, concept strengths, and latest question run; plus the
 * module's weak concepts and how many questions are waiting to be retried.
 */
export const overview = query({
  args: {
    projectId: v.id("projects"),
    /** Client clock, rounded to the minute, so due counts refresh as time passes. */
    now: v.number(),
  },
  handler: async (ctx, { projectId, now }) => {
    const units = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
      .collect()
    const reviews = await reviewsByConcept(ctx, projectId)
    let missed = 0
    let unanswered = 0
    let due = 0
    const weak: Array<ConceptSummary & { unitId: Id<"units">; unitTitle: string }> = []
    const result = []
    for (const unit of units) {
      const allQuestions = (
        await ctx.db
          .query("learningItems")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect()
      ).filter(isQuestion)
      // Exam questions shape concept strength but are not drillable bank questions.
      const items = allQuestions.filter(isPracticeQuestion)
      let answered = 0
      let correct = 0
      for (const item of items) {
        if (!item.lastOutcome) {
          unanswered += 1
          continue
        }
        answered += 1
        if (item.lastOutcome === "correct") correct += 1
        else missed += 1
      }
      const concepts: ConceptSummary[] = []
      for (const conceptId of [...new Set(allQuestions.map((item) => item.conceptId))]) {
        const concept = await ctx.db.get(conceptId)
        if (!concept) continue
        const review = reviews.get(String(conceptId))
        const history = historyOf(review)
        if (review && review.attemptCount > 0 && review.dueAt <= now) due += 1
        const summary = {
          id: concept._id,
          title: concept.title,
          strength: conceptStrength(history),
          attempts: history.attempts,
          accuracy: history.attempts ? history.correct / history.attempts : null,
        }
        concepts.push(summary)
        if (summary.strength === "weak")
          weak.push({ ...summary, unitId: unit._id, unitTitle: unit.title })
      }
      const generation = await ctx.db
        .query("questionGenerations")
        .withIndex("by_unit_startedAt", (q) => q.eq("unitId", unit._id))
        .order("desc")
        .first()
      result.push({
        id: unit._id,
        title: unit.title,
        questionCount: items.length,
        answeredCount: answered,
        correctCount: correct,
        concepts: concepts.sort((a, b) => a.title.localeCompare(b.title)),
        generation: generation
          ? {
              id: generation._id,
              status:
                generation.status === "running" &&
                generation.startedAt <= now - GENERATION_LEASE_MS
                  ? ("failed" as const)
                  : generation.status,
              createdCount: generation.createdCount,
              requestedCount: generation.requestedCount,
              error: generation.error ?? null,
              startedAt: generation.startedAt,
            }
          : null,
      })
    }
    return {
      units: result,
      weakConcepts: weak,
      missedCount: missed,
      unansweredCount: unanswered,
      dueConceptCount: due,
    }
  },
})

/** Arguments shared by the drill queries. */
const drillArgs = {
  projectId: v.id("projects"),
  unitId: v.optional(v.id("units")),
  limit: v.optional(v.number()),
  /** Client clock, so concepts that fell due recently count as due. */
  now: v.number(),
}

/**
 * Picks a drill's questions in order: questions answered wrongly first, then
 * concepts due for review, then unanswered questions on weak concepts, then
 * the rest (`selectDrillQuestions`).
 * @returns Each question's item, its unit title, and its last outcome.
 */
async function drillQuestions(
  ctx: QueryCtx,
  { projectId, unitId, limit, now }: { projectId: Id<"projects">; unitId?: Id<"units">; limit?: number; now: number }
) {
  const units = await ctx.db
    .query("units")
    .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
    .collect()
  const unitTitles = new Map(units.map((unit) => [String(unit._id), unit.title]))
  const scope = unitId ? units.filter((unit) => unit._id === unitId) : units
  const items: Doc<"learningItems">[] = []
  for (const unit of scope)
    items.push(
      ...(
        await ctx.db
          .query("learningItems")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect()
      ).filter(isPracticeQuestion)
    )
  const reviews = await reviewsByConcept(ctx, projectId)
  const candidates: DrillCandidate[] = []
  for (const item of items) {
    const review = reviews.get(String(item.conceptId))
    candidates.push({
      itemId: String(item._id),
      conceptId: String(item.conceptId),
      createdAt: item.createdAt,
      ...(item.lastOutcome
        ? { lastOutcome: item.lastOutcome, lastAnsweredAt: item.lastAnsweredAt }
        : {}),
      strength: conceptStrength(historyOf(review)),
      ...(review && review.attemptCount > 0 ? { conceptDueAt: review.dueAt } : {}),
    })
  }
  const order = selectDrillQuestions(
    candidates,
    now,
    Math.max(1, Math.min(MAX_DRILL_QUESTIONS, Math.round(limit ?? 10)))
  )
  const byId = new Map(items.map((item) => [String(item._id), item]))
  return order.map((id) => {
    const item = byId.get(id)!
    return {
      item,
      unitTitle: unitTitles.get(String(item.unitId)) ?? "",
      lastOutcome: candidates.find((entry) => entry.itemId === id)!.lastOutcome ?? null,
    }
  })
}

/**
 * Builds an adaptive drill (see `drillQuestions`) for the web drill screen.
 * Questions include their answer key so the quiz renderer can mark options;
 * every answer is still scored and recorded by the server.
 */
export const drill = query({
  args: drillArgs,
  handler: async (ctx, args) =>
    (await drillQuestions(ctx, args)).map(({ item, unitTitle, lastOutcome }) => ({
      itemId: item._id,
      unitId: item.unitId!,
      unitTitle,
      lastOutcome,
      quiz: quizShape(item),
    })),
})

/**
 * Builds the same adaptive drill as `drill`, as feed-contract question cards
 * without answer keys, for clients such as the Android app that reveal the
 * key only from the server's answer feedback.
 */
export const drillCards = query({
  args: drillArgs,
  handler: async (ctx, args) =>
    (await drillQuestions(ctx, args)).map(({ item, unitTitle, lastOutcome }) => ({
      card: feedCard(item, unitTitle),
      unitId: String(item.unitId),
      lastOutcome,
    })),
})

/** Most recently shown items avoided when the feed starts a new round. */
const FEED_ROUND_GAP = 8

/**
 * Serves the Review feed: questions and short recaps from units the learner has
 * started, missed and weak material first, never ending. Each page excludes
 * items already shown in this feed session; once everything has been shown,
 * a new round begins that still skips the most recent few.
 *
 * Cards match the shared feed contract, so question cards carry no answer key;
 * answers are scored by `learning.recordAnswerEvent`.
 */
export const feed = query({
  args: {
    projectId: v.optional(v.id("projects")),
    /** Item IDs already shown in this feed session, newest last. */
    seen: v.array(v.string()),
    limit: v.number(),
    /** Server clock from the route, so due reviews are judged at request time. */
    now: v.number(),
  },
  handler: async (ctx, { projectId, seen, limit, now }) => {
    const pageSize = Math.max(1, Math.min(30, Math.round(limit)))
    const allUnits = projectId
      ? await ctx.db
          .query("units")
          .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
          .collect()
      : await ctx.db.query("units").collect()
    // Archived modules leave the mixed feed; filtering to one still shows it.
    const archived = projectId
      ? new Set<string>()
      : new Set(
          (await ctx.db.query("projects").collect())
            .filter((project) => project.archivedAt !== undefined)
            .map((project) => String(project._id))
        )
    // Only units the learner has started belong in the feed.
    const startedUnits = allUnits.filter(
      (unit) => unit.startedAt && !archived.has(String(unit.projectId))
    )
    const projectTitles = new Map<string, string>()
    const reviewCache = new Map<string, Awaited<ReturnType<typeof reviewsByConcept>>>()
    const questions: Array<{ item: Doc<"learningItems">; candidate: DrillCandidate }> = []
    const recaps = new Map<string, Doc<"learningItems">>()
    const strengthByConcept = new Map<string, ConceptStrength>()
    const studiedProjects = new Set<string>()
    for (const unit of startedUnits) {
      const items = (
        await ctx.db
          .query("learningItems")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect()
      ).filter((item) => !item.archivedAt)
      if (!items.length) continue
      const projectKey = String(unit.projectId)
      if (!reviewCache.has(projectKey))
        reviewCache.set(projectKey, await reviewsByConcept(ctx, unit.projectId))
      const reviews = reviewCache.get(projectKey)!
      const unitQuestions: typeof questions = []
      for (const item of items) {
        const strength = conceptStrength(historyOf(reviews.get(String(item.conceptId))))
        strengthByConcept.set(String(item.conceptId), strength)
        if (item.type === "explain") {
          recaps.set(String(item.conceptId), item)
          continue
        }
        if (!isPracticeQuestion(item)) continue
        const review = reviews.get(String(item.conceptId))
        unitQuestions.push({
          item,
          candidate: {
            itemId: String(item._id),
            conceptId: String(item.conceptId),
            createdAt: item.createdAt,
            ...(item.lastOutcome
              ? { lastOutcome: item.lastOutcome, lastAnsweredAt: item.lastAnsweredAt }
              : {}),
            strength,
            ...(review && review.attemptCount > 0 ? { conceptDueAt: review.dueAt } : {}),
          },
        })
      }
      questions.push(...unitQuestions)
      studiedProjects.add(projectKey)
      if (!projectTitles.has(projectKey)) {
        const project = await ctx.db.get(unit.projectId)
        if (project) projectTitles.set(projectKey, project.title)
      }
    }
    const unitTitles = new Map(allUnits.map((unit) => [String(unit._id), unit.title]))

    const seenSet = new Set(seen)
    let pool = questions.filter((entry) => !seenSet.has(entry.candidate.itemId))
    let roundSeen = seenSet
    if (!pool.length && questions.length) {
      // Everything has been shown: start a new round, skipping the most recent few.
      roundSeen = new Set(seen.slice(-FEED_ROUND_GAP))
      pool = questions.filter((entry) => !roundSeen.has(entry.candidate.itemId))
      if (!pool.length) pool = questions
    }
    const order = selectDrillQuestions(
      pool.map((entry) => entry.candidate),
      now,
      pageSize
    )
    const byId = new Map(questions.map((entry) => [entry.candidate.itemId, entry.item]))

    /** A feed card whose key is unique within the feed session, so repeats render anew. */
    const card = (item: Doc<"learningItems">) =>
      feedCard(item, unitTitles.get(String(item.unitId)) ?? "", `${String(item._id)}:${seen.length + cards.length}`)

    const cards = []
    const placedRecaps = new Set<string>()
    let questionsSinceRecap = 2
    for (const id of order) {
      const item = byId.get(id)!
      const conceptId = String(item.conceptId)
      const recap = recaps.get(conceptId)
      const strength = strengthByConcept.get(conceptId)
      // A recap comes before a question on a concept that is not sticking yet.
      if (
        recap &&
        strength !== "strong" &&
        questionsSinceRecap >= 2 &&
        !placedRecaps.has(conceptId) &&
        !roundSeen.has(String(recap._id))
      ) {
        cards.push(card(recap))
        placedRecaps.add(conceptId)
        questionsSinceRecap = 0
      }
      cards.push(card(item))
      questionsSinceRecap += 1
    }
    return {
      cards,
      projects: [...studiedProjects].map((id) => ({ id, title: projectTitles.get(id) ?? "" })),
      topics: [] as Array<{ id: string; projectId: string; title: string }>,
      hasMaterial: questions.length > 0,
    }
  },
})

/**
 * One-off backfill for data created before items stored their latest answer
 * and units stored when they were started. Safe to run more than once.
 * Run with `npx convex run practice:backfillProgressFields`.
 */
export const backfillProgressFields = internalMutation({
  args: {},
  handler: async (ctx) => {
    let items = 0
    let units = 0
    for (const unit of await ctx.db.query("units").collect()) {
      let started = unit.startedAt
      const unitItems = await ctx.db
        .query("learningItems")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect()
      for (const item of unitItems) {
        const last = await latestAnswer(ctx, item._id)
        if (last?.outcome && item.lastAnsweredAt !== last.occurredAt) {
          await ctx.db.patch(item._id, {
            lastOutcome: last.outcome,
            lastAnsweredAt: last.occurredAt,
          })
          items += 1
        }
        if (last && (!started || last.occurredAt < started)) started = last.occurredAt
      }
      const chat = await ctx.db
        .query("workspaceChats")
        .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unit._id))
        .first()
      if (chat?.teachOutline && (!started || chat.createdAt < started)) started = chat.createdAt
      if (started && started !== unit.startedAt) {
        await ctx.db.patch(unit._id, { startedAt: started })
        units += 1
      }
    }
    return { items, units }
  },
})
