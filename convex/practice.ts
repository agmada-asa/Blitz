/**
 * Owns exam practice data: each unit's question bank and the runs that write
 * it, the per-concept mastery overview, and the adaptive drill deck that asks
 * missed and weak material first.
 *
 * Questions are ordinary learning items (`origin: "bank"` for generated ones,
 * `"teach"` for lesson quizzes), so answers flow through
 * `learning.recordAnswerEvent` and update the same review state.
 */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
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
const QUESTION_TYPES = new Set(["single-choice", "multiple-answer", "true-false"])

/** A generated question as saved by the server route after validation. */
const generatedQuestion = v.object({
  concept: v.string(),
  type: v.union(
    v.literal("single-choice"),
    v.literal("multiple-answer"),
    v.literal("true-false")
  ),
  question: v.string(),
  options: v.array(v.object({ id: v.string(), text: v.string() })),
  correctOptionIds: v.array(v.string()),
  explanation: v.string(),
})

/** Normalises a concept title for matching. */
function conceptTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 120) || "General"
}

/** Returns whether a learning item is an answerable question. */
function isQuestion(item: Doc<"learningItems">): boolean {
  return QUESTION_TYPES.has(item.type) && !item.archivedAt && Boolean(item.question)
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
  const options =
    item.type === "true-false"
      ? [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ]
      : (item.options ?? [])
  const correctOptionIds =
    item.type === "true-false"
      ? [String(item.correctAnswer ?? false)]
      : item.type === "single-choice"
        ? item.correctOptionId
          ? [item.correctOptionId]
          : []
        : (item.correctOptionIds ?? [])
  return {
    kind: "quiz" as const,
    id: String(item._id),
    concept: item.title,
    type: item.type as "single-choice" | "multiple-answer" | "true-false",
    question: item.question ?? "",
    options,
    correctOptionIds,
    explanation: item.body,
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
      existingQuestions: items.map((item) => item.question ?? "").filter(Boolean),
    }
  },
})

/**
 * Starts a question-bank run for a unit unless one is already running.
 * @returns The run ID, or `alreadyRunning` with the active run's ID.
 */
export const startGeneration = mutation({
  args: { unitId: v.id("units"), count: v.number() },
  handler: async (ctx, { unitId, count }) => {
    const unit = await ctx.db.get(unitId)
    if (!unit) throw new Error("Unit not found")
    const now = Date.now()
    const latest = await ctx.db
      .query("questionGenerations")
      .withIndex("by_unit_startedAt", (q) => q.eq("unitId", unitId))
      .order("desc")
      .first()
    if (latest?.status === "running" && latest.startedAt > now - GENERATION_LEASE_MS)
      return { generationId: latest._id, alreadyRunning: true }
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
    return { generationId, alreadyRunning: false }
  },
})

/**
 * Saves validated questions from a run as learning items under their
 * concepts. Concepts are matched by title within the project.
 */
export const saveGeneratedQuestions = mutation({
  args: {
    generationId: v.id("questionGenerations"),
    questions: v.array(generatedQuestion),
    rejectedCount: v.number(),
  },
  handler: async (ctx, { generationId, questions, rejectedCount }) => {
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
    for (const [index, question] of questions.entries()) {
      const title = conceptTitle(question.concept)
      let concept = await ctx.db
        .query("concepts")
        .withIndex("by_project_title", (q) => q.eq("projectId", run.projectId).eq("title", title))
        .first()
      if (!concept) {
        const conceptId = await ctx.db.insert("concepts", {
          projectId: run.projectId,
          unitId: run.unitId,
          title,
          sourceIds,
          createdAt: now,
        })
        concept = (await ctx.db.get(conceptId))!
      }
      await ctx.db.insert("learningItems", {
        projectId: run.projectId,
        conceptId: concept._id,
        unitId: run.unitId,
        origin: "bank",
        sourceIds,
        type: question.type,
        title,
        body: question.explanation.slice(0, 4_000),
        question: question.question.slice(0, 2_000),
        ...(question.type === "true-false"
          ? { correctAnswer: question.correctOptionIds[0] === "true" }
          : {
              options: question.options,
              ...(question.type === "single-choice"
                ? { correctOptionId: question.correctOptionIds[0] }
                : { correctOptionIds: question.correctOptionIds }),
            }),
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
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const units = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
      .collect()
    const reviews = await reviewsByConcept(ctx, projectId)
    const now = Date.now()
    let missed = 0
    let unanswered = 0
    let due = 0
    const weak: Array<ConceptSummary & { unitId: Id<"units">; unitTitle: string }> = []
    const result = []
    for (const unit of units) {
      const items = (
        await ctx.db
          .query("learningItems")
          .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
          .collect()
      ).filter(isQuestion)
      let answered = 0
      let correct = 0
      for (const item of items) {
        const last = await latestAnswer(ctx, item._id)
        if (!last) {
          unanswered += 1
          continue
        }
        answered += 1
        if (last.outcome === "correct") correct += 1
        else missed += 1
      }
      const concepts: ConceptSummary[] = []
      for (const conceptId of [...new Set(items.map((item) => item.conceptId))]) {
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

/**
 * Builds an adaptive drill: questions answered wrongly first, then concepts
 * due for review, then unanswered questions on weak concepts, then the rest.
 * Questions include their answer key so the quiz renderer can mark options;
 * every answer is still scored and recorded by the server.
 */
export const drill = query({
  args: {
    projectId: v.id("projects"),
    unitId: v.optional(v.id("units")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { projectId, unitId, limit }) => {
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
        ).filter(isQuestion)
      )
    const reviews = await reviewsByConcept(ctx, projectId)
    const candidates: DrillCandidate[] = []
    for (const item of items) {
      const last = await latestAnswer(ctx, item._id)
      const review = reviews.get(String(item.conceptId))
      candidates.push({
        itemId: String(item._id),
        conceptId: String(item.conceptId),
        createdAt: item.createdAt,
        ...(last?.outcome ? { lastOutcome: last.outcome, lastAnsweredAt: last.occurredAt } : {}),
        strength: conceptStrength(historyOf(review)),
        ...(review && review.attemptCount > 0 ? { conceptDueAt: review.dueAt } : {}),
      })
    }
    const order = selectDrillQuestions(
      candidates,
      Date.now(),
      Math.max(1, Math.min(MAX_DRILL_QUESTIONS, Math.round(limit ?? 10)))
    )
    const byId = new Map(items.map((item) => [String(item._id), item]))
    return order.map((id) => {
      const item = byId.get(id)!
      const candidate = candidates.find((entry) => entry.itemId === id)!
      return {
        itemId: item._id,
        unitId: item.unitId!,
        unitTitle: unitTitles.get(String(item.unitId)) ?? "",
        lastOutcome: candidate.lastOutcome ?? null,
        quiz: quizShape(item),
      }
    })
  },
})
