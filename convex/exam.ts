/**
 * Owns exam mode data: past and mock papers and the runs that prepare them,
 * timed attempts with autosaved answers, deterministic marking of choice
 * questions, and the results of the background run that marks written
 * answers.
 *
 * A paper's choice questions become learning items (`origin: "exam"`) when
 * the paper is ready, and the submit route records each choice answer with
 * `learning.recordAnswerEvent`, so exams update concept review like any other
 * practice. Those items are kept out of the feed and drills (see
 * `convex/practice.ts`) so a paper's answers are never shown before it is
 * taken. Answer keys are only returned for submitted attempts.
 */

import { v } from "convex/values"

import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { examAnswerFields, examQuestionFields } from "./examFields"
import { conceptStrength } from "../lib/drill"
import {
  attemptTotals,
  clampMarks,
  conceptBreakdown,
  DEFAULT_EXAM_MINUTES,
  EXAM_DEADLINE_GRACE_MS,
  EXAM_LIMITS,
  EXAM_MARK_RANGE,
  isChoiceType,
  MAX_PAPER_QUESTIONS,
  MAX_WRITTEN_ANSWER_CHARS,
  MOCK_EXAM_MINUTES,
  scoreAttempt,
  type ExamAnswer,
  type ExamQuestionResult,
} from "../lib/exam-scoring"

/** A paper or grading run older than this is treated as abandoned. */
const RUN_LEASE_MS = 10 * 60 * 1000

/** Characters of each source's extracted text returned for a prompt; prompts budget further. */
const MAX_CONTEXT_SOURCE_TEXT = 200_000

/** Most attempts read for one paper. */
const MAX_ATTEMPTS_READ = 100

/** Most units a mock paper may cover. */
const MAX_MOCK_UNITS = 40

/** Ready past papers shown to the model as style examples for a mock. */
const MAX_STYLE_EXAMPLES = 2

/** A stored exam question. */
type ExamQuestionDoc = Doc<"examPapers">["questions"][number]

/** Message shown when a run stopped without reporting back. */
const STALE_RUN_ERROR = "Preparing this paper stopped before finishing. Try again."

/** Returns a paper's status, treating a processing run past its lease as failed. */
function paperStatus(paper: Doc<"examPapers">, now: number) {
  if (paper.status === "processing" && paper.runStartedAt <= now - RUN_LEASE_MS)
    return { status: "failed" as const, error: STALE_RUN_ERROR }
  return { status: paper.status, error: paper.error ?? null }
}

/** Returns an attempt's grading status, treating a grading run past its lease as failed. */
function gradingStatus(attempt: Doc<"examAttempts">, now: number) {
  if (
    attempt.gradingStatus === "running" &&
    (attempt.gradingStartedAt ?? 0) <= now - RUN_LEASE_MS
  )
    return {
      status: "failed" as const,
      error: "Marking stopped before finishing. Try again.",
    }
  return { status: attempt.gradingStatus ?? null, error: attempt.gradingError ?? null }
}

/** Shapes a question for the paper being sat: no answers, explanations, or mark schemes. */
function publicQuestion(question: ExamQuestionDoc) {
  return {
    id: question.id,
    number: question.number,
    marks: question.marks,
    type: question.type,
    prompt: question.prompt,
    options: question.options ?? [],
  }
}

/** Counts a paper's choice and written questions. */
function questionCounts(questions: ExamQuestionDoc[]) {
  const written = questions.filter((question) => question.type === "written").length
  return { choiceCount: questions.length - written, writtenCount: written }
}

/** Shapes questions for scoring and the concept breakdown. */
function scorable(questions: ExamQuestionDoc[]) {
  return questions.map((question) => ({
    id: question.id,
    type: question.type,
    marks: question.marks,
    correctOptionIds: question.correctOptionIds,
    options: question.options,
    concept: question.concept,
    ...(question.unitId ? { unitId: String(question.unitId) } : {}),
  }))
}

/**
 * Keeps only well-formed answers to questions on the paper: known option ids
 * (at most one for single-choice and true-false), bounded text, and one
 * answer per question.
 */
function sanitizeAnswers(
  questions: ExamQuestionDoc[],
  answers: ExamAnswer[]
): ExamAnswer[] {
  const byId = new Map(questions.map((question) => [question.id, question]))
  const result = new Map<string, ExamAnswer>()
  for (const answer of answers.slice(0, MAX_PAPER_QUESTIONS * 2)) {
    const question = byId.get(answer.questionId)
    if (!question) continue
    if (isChoiceType(question.type)) {
      const chosen = new Set(answer.selectedOptionIds ?? [])
      let selected = (question.options ?? [])
        .map((option) => option.id)
        .filter((id) => chosen.has(id))
      if (question.type !== "multiple-answer") selected = selected.slice(0, 1)
      result.set(question.id, { questionId: question.id, selectedOptionIds: selected })
    } else {
      result.set(question.id, {
        questionId: question.id,
        text: (answer.text ?? "").slice(0, MAX_WRITTEN_ANSWER_CHARS),
      })
    }
  }
  return [...result.values()]
}

/** Returns a percentage for an attempt whose marking is finished, or null. */
function finishedPercentage(attempt: Doc<"examAttempts">): number | null {
  if (attempt.status !== "submitted") return null
  if (attempt.gradingStatus !== "completed" && attempt.gradingStatus !== "not_needed") return null
  if (!attempt.availableMarks) return null
  return Math.round(((attempt.awardedMarks ?? 0) / attempt.availableMarks) * 100)
}

/** Loads a paper's attempts, newest first. */
async function attemptsFor(ctx: Pick<QueryCtx, "db">, paperId: Id<"examPapers">) {
  return ctx.db
    .query("examAttempts")
    .withIndex("by_paper_startedAt", (q) => q.eq("paperId", paperId))
    .order("desc")
    .take(MAX_ATTEMPTS_READ)
}

/**
 * Lists a module's exam papers, newest first, with status, size, best
 * finished score, and the attempts to resume or review.
 */
export const listPapers = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const papers = await ctx.db
      .query("examPapers")
      .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(100)
    const now = Date.now()
    const result = []
    for (const paper of papers) {
      const attempts = await attemptsFor(ctx, paper._id)
      const submitted = attempts.filter((attempt) => attempt.status === "submitted")
      const percentages = submitted
        .map(finishedPercentage)
        .filter((value): value is number => value !== null)
      const { status, error } = paperStatus(paper, now)
      result.push({
        id: paper._id,
        kind: paper.kind,
        title: paper.title,
        status,
        error,
        runStartedAt: paper.runStartedAt,
        questionCount: paper.questions.length,
        ...questionCounts(paper.questions),
        totalMarks: paper.totalMarks ?? null,
        durationMinutes: paper.durationMinutes ?? null,
        bestPercentage: percentages.length ? Math.max(...percentages) : null,
        inProgressAttemptId:
          attempts.find((attempt) => attempt.status === "in_progress")?._id ?? null,
        latestAttemptId: submitted[0]?._id ?? null,
        attemptCount: submitted.length,
      })
    }
    return result
  },
})

/** Returns a filename without its extension, as a default paper title. */
function titleFromFilename(filename: string): string {
  return (
    filename
      .replace(/\.[A-Za-z0-9]{1,8}$/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, EXAM_LIMITS.titleChars) || "Past paper"
  )
}

/**
 * Records an uploaded past paper and starts preparing it. Uploading the same
 * paper again returns the existing record; a failed one is restarted, with
 * newly supplied solutions.
 * @returns The paper ID, and the run's `runStartedAt` when the caller should start a run.
 */
export const createPastPaper = mutation({
  args: {
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    solutionsSourceId: v.optional(v.id("sources")),
  },
  handler: async (ctx, { projectId, sourceId, solutionsSourceId }) => {
    const source = await ctx.db.get(sourceId)
    if (!source || source.projectId !== projectId) throw new Error("Paper not found")
    if (solutionsSourceId) {
      const solutions = await ctx.db.get(solutionsSourceId)
      if (!solutions || solutions.projectId !== projectId || solutionsSourceId === sourceId)
        throw new Error("Solutions not found")
    }
    const now = Date.now()
    const existing = await ctx.db
      .query("examPapers")
      .withIndex("by_project_source", (q) => q.eq("projectId", projectId).eq("sourceId", sourceId))
      .first()
    if (existing) {
      if (paperStatus(existing, now).status !== "failed")
        return { paperId: existing._id, runStartedAt: null }
      await ctx.db.patch(existing._id, {
        status: "processing",
        error: undefined,
        runStartedAt: now,
        ...(solutionsSourceId ? { solutionsSourceId } : {}),
      })
      return { paperId: existing._id, runStartedAt: now }
    }
    const paperId = await ctx.db.insert("examPapers", {
      projectId,
      kind: "past",
      title: titleFromFilename(source.filename),
      status: "processing",
      sourceId,
      ...(solutionsSourceId ? { solutionsSourceId } : {}),
      questions: [],
      runStartedAt: now,
      createdAt: now,
    })
    return { paperId, runStartedAt: now }
  },
})

/**
 * Records a mock paper for the chosen units and length and starts writing
 * it. Only one mock is written per module at a time.
 * @returns The paper ID, and the run's `runStartedAt` when the caller should start a run.
 */
export const createMockPaper = mutation({
  args: {
    projectId: v.id("projects"),
    unitIds: v.array(v.id("units")),
    minutes: v.number(),
  },
  handler: async (ctx, { projectId, unitIds, minutes }) => {
    if (!(MOCK_EXAM_MINUTES as readonly number[]).includes(minutes))
      throw new Error("Choose 30, 60, or 90 minutes")
    const unique = [...new Set(unitIds)]
    if (!unique.length || unique.length > MAX_MOCK_UNITS) throw new Error("Choose at least one unit")
    for (const unitId of unique) {
      const unit = await ctx.db.get(unitId)
      if (!unit || unit.projectId !== projectId) throw new Error("Unit not found")
    }
    const now = Date.now()
    const papers = await ctx.db
      .query("examPapers")
      .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
      .collect()
    const mocks = papers.filter((paper) => paper.kind === "mock")
    const running = mocks.find((paper) => paperStatus(paper, now).status === "processing")
    if (running) return { paperId: running._id, runStartedAt: null }
    const paperId = await ctx.db.insert("examPapers", {
      projectId,
      kind: "mock",
      title: `Mock exam ${mocks.length + 1}`,
      status: "processing",
      unitIds: unique,
      durationMinutes: minutes,
      questions: [],
      runStartedAt: now,
      createdAt: now,
    })
    return { paperId, runStartedAt: now }
  },
})

/**
 * Restarts preparing a paper whose last run failed or stopped.
 * @returns The paper kind and new `runStartedAt`, or null `runStartedAt` when nothing should start.
 */
export const restartPaper = mutation({
  args: { paperId: v.id("examPapers") },
  handler: async (ctx, { paperId }) => {
    const paper = await ctx.db.get(paperId)
    if (!paper) throw new Error("Paper not found")
    const now = Date.now()
    if (paperStatus(paper, now).status !== "failed")
      return { kind: paper.kind, runStartedAt: null }
    await ctx.db.patch(paperId, { status: "processing", error: undefined, runStartedAt: now })
    return { kind: paper.kind, runStartedAt: now }
  },
})

/** Loads every concept review in a project, keyed by concept. */
async function reviewsByConcept(ctx: Pick<QueryCtx, "db">, projectId: Id<"projects">) {
  const reviews = await ctx.db
    .query("conceptReviews")
    .withIndex("by_project_dueAt", (q) => q.eq("projectId", projectId))
    .collect()
  return new Map(reviews.map((review) => [String(review.conceptId), review]))
}

/**
 * Supplies the server run with what its prompt needs. For a past paper: the
 * paper and solutions text and the module's units with their concept names.
 * For a mock: the selected units' material and concepts, weak concepts, and
 * up to two ready past papers as style examples. Units are keyed U1, U2, …
 * so the model can name one; `unitIds` maps keys back. Server-only.
 */
export const paperContext = query({
  args: { paperId: v.id("examPapers") },
  handler: async (ctx, { paperId }) => {
    const paper = await ctx.db.get(paperId)
    if (!paper) return null
    const project = await ctx.db.get(paper.projectId)
    if (!project) return null
    const allUnits = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", paper.projectId))
      .collect()
    const units =
      paper.kind === "mock"
        ? allUnits.filter((unit) => paper.unitIds?.includes(unit._id))
        : allUnits
    const concepts = await ctx.db
      .query("concepts")
      .withIndex("by_project", (q) => q.eq("projectId", paper.projectId))
      .collect()
    const unitOptions = units.map((unit, index) => ({
      key: `U${index + 1}`,
      unitId: unit._id,
      title: unit.title,
      concepts: concepts
        .filter((concept) => concept.unitId === unit._id)
        .map((concept) => concept.title),
    }))
    const base = {
      kind: paper.kind,
      runStartedAt: paper.runStartedAt,
      status: paper.status,
      moduleTitle: project.title,
      units: unitOptions,
    }
    if (paper.kind === "past") {
      const source = paper.sourceId ? await ctx.db.get(paper.sourceId) : null
      const solutions = paper.solutionsSourceId ? await ctx.db.get(paper.solutionsSourceId) : null
      return {
        ...base,
        paper: source
          ? {
              filename: source.filename,
              text: source.extractedText.slice(0, MAX_CONTEXT_SOURCE_TEXT),
            }
          : null,
        solutions: solutions
          ? {
              filename: solutions.filename,
              text: solutions.extractedText.slice(0, MAX_CONTEXT_SOURCE_TEXT),
            }
          : null,
        minutes: null,
        sources: [],
        weakConcepts: [],
        examples: [],
      }
    }
    const sources = []
    for (const unit of units) {
      const unitSources = await ctx.db
        .query("sources")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect()
      for (const source of unitSources.sort((a, b) => a.createdAt - b.createdAt))
        if (source.extractedText.trim())
          sources.push({
            filename: source.filename,
            unitTitle: unit.title,
            text: source.extractedText.slice(0, MAX_CONTEXT_SOURCE_TEXT),
          })
    }
    const reviews = await reviewsByConcept(ctx, paper.projectId)
    const selected = new Set(units.map((unit) => String(unit._id)))
    const weakConcepts = concepts
      .filter((concept) => concept.unitId && selected.has(String(concept.unitId)))
      .filter((concept) => {
        const review = reviews.get(String(concept._id))
        return (
          conceptStrength({
            attempts: review?.attemptCount ?? 0,
            correct: review?.correctCount ?? 0,
            consecutiveCorrect: review?.consecutiveCorrect ?? 0,
            ...(review?.lastOutcome ? { lastOutcome: review.lastOutcome } : {}),
          }) === "weak"
        )
      })
      .map((concept) => concept.title)
    const pastPapers = (
      await ctx.db
        .query("examPapers")
        .withIndex("by_project_createdAt", (q) => q.eq("projectId", paper.projectId))
        .order("desc")
        .collect()
    )
      .filter((other) => other.kind === "past" && other.status === "ready" && other.questions.length)
      .slice(0, MAX_STYLE_EXAMPLES)
    return {
      ...base,
      paper: null,
      solutions: null,
      minutes: paper.durationMinutes ?? DEFAULT_EXAM_MINUTES,
      sources,
      weakConcepts,
      examples: pastPapers.map((other) => ({
        title: other.title,
        ...(other.durationMinutes ? { durationMinutes: other.durationMinutes } : {}),
        questions: other.questions.map((question) => ({
          number: question.number,
          type: question.type,
          marks: question.marks,
          prompt: question.prompt,
          ...(question.options?.length && question.type !== "true-false"
            ? { options: question.options.map((option) => option.text) }
            : {}),
        })),
      })),
    }
  },
})

/** Trims a string and limits its length. */
function bounded(text: string | undefined, max: number): string {
  return (text ?? "").trim().slice(0, max)
}

/** Re-checks a validated question's bounds before it is stored. */
function storedQuestion(question: ExamQuestionDoc, index: number): ExamQuestionDoc {
  const marks = clampMarks(question.marks, EXAM_MARK_RANGE.max)
  if (marks < EXAM_MARK_RANGE.min) throw new Error("A question has no marks")
  const prompt = bounded(question.prompt, EXAM_LIMITS.promptChars)
  if (!prompt) throw new Error("A question has no prompt")
  const base = {
    id: `q${index + 1}`,
    number: bounded(question.number, EXAM_LIMITS.numberChars) || String(index + 1),
    marks,
    type: question.type,
    prompt,
    concept: bounded(question.concept, EXAM_LIMITS.conceptChars) || "General",
    ...(question.unitId ? { unitId: question.unitId } : {}),
    ...(question.answerSource ? { answerSource: question.answerSource } : {}),
  }
  if (question.type === "written") {
    const markScheme = (question.markScheme ?? [])
      .slice(0, EXAM_LIMITS.maxMarkPoints)
      .map((point) => ({
        point: bounded(point.point, EXAM_LIMITS.markPointChars),
        marks: clampMarks(point.marks, EXAM_MARK_RANGE.max),
      }))
      .filter((point) => point.point && point.marks > 0)
    const modelAnswer = bounded(question.modelAnswer, EXAM_LIMITS.modelAnswerChars)
    if (!markScheme.length || !modelAnswer) throw new Error("A written question has no mark scheme")
    return { ...base, modelAnswer, markScheme }
  }
  const options = (question.options ?? []).slice(0, EXAM_LIMITS.maxOptions).map((option) => ({
    id: option.id,
    text: bounded(option.text, EXAM_LIMITS.optionChars),
  }))
  const optionIds = new Set(options.map((option) => option.id))
  const correctOptionIds = (question.correctOptionIds ?? []).filter((id) => optionIds.has(id))
  if (options.length < 2 || !correctOptionIds.length)
    throw new Error("A choice question has no valid answer")
  return {
    ...base,
    options,
    correctOptionIds,
    explanation: bounded(question.explanation, EXAM_LIMITS.explanationChars),
  }
}

/**
 * Finds a concept by title within the question's unit, creating it when new.
 * Concepts are per unit, as in Teach and practice: the same generic title in
 * two units is two concepts. Questions with no unit share unit-less concepts.
 */
async function conceptFor(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  name: string,
  unitId: Id<"units"> | undefined,
  sourceIds: Id<"sources">[],
  now: number
) {
  const title = name.replace(/\s+/g, " ").trim().slice(0, 120) || "General"
  const existing = (
    await ctx.db
      .query("concepts")
      .withIndex("by_project_title", (q) => q.eq("projectId", projectId).eq("title", title))
      .collect()
  ).find((candidate) => candidate.unitId === unitId)
  if (existing) return existing
  const conceptId = await ctx.db.insert("concepts", {
    projectId,
    ...(unitId ? { unitId } : {}),
    title,
    sourceIds,
    createdAt: now,
  })
  return (await ctx.db.get(conceptId))!
}

/**
 * Saves a run's validated questions and marks the paper ready. Each choice
 * question becomes an `exam` learning item under its concept and unit, so
 * answers update concept review. Ignored when a newer run has started.
 */
export const savePaper = mutation({
  args: {
    paperId: v.id("examPapers"),
    runStartedAt: v.number(),
    title: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    statedTotalMarks: v.optional(v.number()),
    questions: v.array(examQuestionFields),
    rejectedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const paper = await ctx.db.get(args.paperId)
    if (!paper || paper.status !== "processing" || paper.runStartedAt !== args.runStartedAt)
      return { saved: false }
    if (!args.questions.length || args.questions.length > MAX_PAPER_QUESTIONS)
      throw new Error("A paper needs 1 to 60 questions")
    const questions = args.questions.map(storedQuestion)
    for (const question of questions)
      if (question.unitId) {
        const unit = await ctx.db.get(question.unitId)
        if (!unit || unit.projectId !== paper.projectId) delete question.unitId
      }
    const now = Date.now()
    const paperSources = [paper.sourceId, paper.solutionsSourceId].filter(
      (id): id is Id<"sources"> => Boolean(id)
    )
    const unitSources = new Map<string, Id<"sources">[]>()
    /** Sources an item cites: the paper itself, or the unit's material for a mock. */
    const sourcesFor = async (unitId: Id<"units"> | undefined) => {
      if (paper.kind === "past" || !unitId) return paperSources
      const key = String(unitId)
      if (!unitSources.has(key))
        unitSources.set(
          key,
          (
            await ctx.db
              .query("sources")
              .withIndex("by_unit", (q) => q.eq("unitId", unitId))
              .collect()
          ).map((source) => source._id)
        )
      return unitSources.get(key)!
    }
    for (const [index, question] of questions.entries()) {
      if (!isChoiceType(question.type)) continue
      const sourceIds = await sourcesFor(question.unitId)
      const concept = await conceptFor(
        ctx,
        paper.projectId,
        question.concept,
        question.unitId,
        sourceIds,
        now
      )
      question.itemId = await ctx.db.insert("learningItems", {
        projectId: paper.projectId,
        conceptId: concept._id,
        ...(question.unitId ? { unitId: question.unitId } : {}),
        origin: "exam",
        sourceIds,
        type: question.type as "single-choice" | "multiple-answer" | "true-false",
        title: concept.title,
        body: question.explanation ?? "",
        question: question.prompt,
        ...(question.type === "true-false"
          ? { correctAnswer: question.correctOptionIds?.[0] === "true" }
          : {
              options: question.options,
              ...(question.type === "single-choice"
                ? { correctOptionId: question.correctOptionIds?.[0] }
                : { correctOptionIds: question.correctOptionIds }),
            }),
        order: now + index,
        createdAt: now,
      })
    }
    const title = args.title ? bounded(args.title, EXAM_LIMITS.titleChars) : ""
    const duration =
      paper.kind === "past" &&
      args.durationMinutes !== undefined &&
      Number.isInteger(args.durationMinutes) &&
      args.durationMinutes >= EXAM_LIMITS.minDurationMinutes &&
      args.durationMinutes <= EXAM_LIMITS.maxDurationMinutes
        ? args.durationMinutes
        : undefined
    const stated =
      args.statedTotalMarks !== undefined &&
      Number.isInteger(args.statedTotalMarks) &&
      args.statedTotalMarks > 0 &&
      args.statedTotalMarks <= EXAM_LIMITS.maxStatedTotalMarks
        ? args.statedTotalMarks
        : undefined
    await ctx.db.patch(args.paperId, {
      status: "ready",
      error: undefined,
      // A mock keeps its numbered name so papers stay easy to tell apart.
      ...(title ? { title: paper.kind === "mock" ? `${paper.title}: ${title}`.slice(0, EXAM_LIMITS.titleChars) : title } : {}),
      ...(duration ? { durationMinutes: duration } : {}),
      ...(stated ? { statedTotalMarks: stated } : {}),
      totalMarks: questions.reduce((sum, question) => sum + question.marks, 0),
      questions,
      rejectedCount: Math.max(0, Math.round(args.rejectedCount)),
      finishedAt: now,
    })
    return { saved: true }
  },
})

/** Marks a paper's run failed with a learner-facing message, unless a newer run has started. */
export const failPaper = mutation({
  args: { paperId: v.id("examPapers"), runStartedAt: v.number(), error: v.string() },
  handler: async (ctx, { paperId, runStartedAt, error }) => {
    const paper = await ctx.db.get(paperId)
    if (!paper || paper.status !== "processing" || paper.runStartedAt !== runStartedAt) return
    await ctx.db.patch(paperId, {
      status: "failed",
      error: error.slice(0, 300),
      finishedAt: Date.now(),
    })
  },
})

/** Shapes a submitted attempt for review, with answer keys, feedback, and the concept breakdown. */
function reviewShape(paper: Doc<"examPapers">, attempt: Doc<"examAttempts">, now: number) {
  const results: ExamQuestionResult[] = attempt.results ?? []
  const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]))
  const resultById = new Map(results.map((result) => [result.questionId, result]))
  const questions = scorable(paper.questions)
  const grading = gradingStatus(attempt, now)
  return {
    id: attempt._id,
    submittedAt: attempt.submittedAt ?? attempt.updatedAt,
    autoSubmitted: Boolean(attempt.autoSubmitted),
    gradingStatus: grading.status,
    gradingError: grading.error,
    totals: attemptTotals(questions, results),
    breakdown: conceptBreakdown(questions, results),
    items: paper.questions.map((question) => ({
      id: question.id,
      number: question.number,
      marks: question.marks,
      type: question.type,
      prompt: question.prompt,
      options: question.options ?? [],
      correctOptionIds: question.correctOptionIds ?? [],
      explanation: question.explanation ?? null,
      modelAnswer: question.modelAnswer ?? null,
      markScheme: question.markScheme ?? [],
      answerSource: question.answerSource ?? null,
      concept: question.concept,
      unitId: question.unitId ?? null,
      selectedOptionIds: answers.get(question.id)?.selectedOptionIds ?? [],
      text: answers.get(question.id)?.text ?? "",
      outcome: resultById.get(question.id)?.outcome ?? "unanswered",
      awardedMarks: resultById.get(question.id)?.awardedMarks ?? null,
      feedback: resultById.get(question.id)?.feedback ?? null,
    })),
  }
}

/**
 * Everything the exam screen needs for one paper: its details, the
 * questions without answers, an attempt in progress to resume, past
 * attempts, and, when `attemptId` names a submitted attempt, its full review.
 */
export const paperSession = query({
  args: { paperId: v.id("examPapers"), attemptId: v.optional(v.id("examAttempts")) },
  handler: async (ctx, { paperId, attemptId }) => {
    const paper = await ctx.db.get(paperId)
    if (!paper) return null
    const now = Date.now()
    const attempts = await attemptsFor(ctx, paperId)
    const active = attempts.find((attempt) => attempt.status === "in_progress")
    const reviewed = attemptId ? await ctx.db.get(attemptId) : null
    const { status, error } = paperStatus(paper, now)
    return {
      paper: {
        id: paper._id,
        projectId: paper.projectId,
        kind: paper.kind,
        title: paper.title,
        status,
        error,
        durationMinutes: paper.durationMinutes ?? null,
        totalMarks: paper.totalMarks ?? null,
        questionCount: paper.questions.length,
        ...questionCounts(paper.questions),
        inferredAnswerCount: paper.questions.filter(
          (question) => question.answerSource === "inferred"
        ).length,
      },
      questions: status === "ready" ? paper.questions.map(publicQuestion) : [],
      active: active
        ? {
            id: active._id,
            startedAt: active.startedAt,
            deadlineAt: active.deadlineAt,
            durationMinutes: active.durationMinutes,
            answers: active.answers,
          }
        : null,
      attempts: attempts
        .filter((attempt) => attempt.status === "submitted")
        .map((attempt) => ({
          id: attempt._id,
          submittedAt: attempt.submittedAt ?? attempt.updatedAt,
          awardedMarks: attempt.awardedMarks ?? 0,
          availableMarks: attempt.availableMarks ?? paper.totalMarks ?? 0,
          percentage: finishedPercentage(attempt),
          gradingStatus: gradingStatus(attempt, now).status,
        })),
      review:
        reviewed && reviewed.paperId === paperId && reviewed.status === "submitted"
          ? reviewShape(paper, reviewed, now)
          : null,
    }
  },
})

/**
 * Starts a timed attempt, or returns the one already in progress so a
 * reload or a second tab resumes it. A past paper's stated time is used;
 * otherwise the learner's choice, defaulting to an hour.
 */
export const startAttempt = mutation({
  args: { paperId: v.id("examPapers"), minutes: v.optional(v.number()) },
  handler: async (ctx, { paperId, minutes }) => {
    const paper = await ctx.db.get(paperId)
    if (!paper || paper.status !== "ready" || !paper.questions.length)
      throw new Error("This paper is not ready yet")
    const active = (await attemptsFor(ctx, paperId)).find(
      (attempt) => attempt.status === "in_progress"
    )
    if (active) return { attemptId: active._id }
    const chosen =
      minutes !== undefined &&
      Number.isInteger(minutes) &&
      minutes >= EXAM_LIMITS.minDurationMinutes &&
      minutes <= EXAM_LIMITS.maxDurationMinutes
        ? minutes
        : undefined
    const durationMinutes = paper.durationMinutes ?? chosen ?? DEFAULT_EXAM_MINUTES
    const now = Date.now()
    const attemptId = await ctx.db.insert("examAttempts", {
      projectId: paper.projectId,
      paperId,
      status: "in_progress",
      durationMinutes,
      startedAt: now,
      deadlineAt: now + durationMinutes * 60_000,
      updatedAt: now,
      answers: [],
    })
    return { attemptId }
  },
})

/**
 * Autosaves an attempt's answers. Answers arriving after the deadline (plus
 * a short grace for network delay) are not saved.
 */
export const saveAnswers = mutation({
  args: { attemptId: v.id("examAttempts"), answers: v.array(examAnswerFields) },
  handler: async (ctx, { attemptId, answers }) => {
    const attempt = await ctx.db.get(attemptId)
    if (!attempt) throw new Error("Attempt not found")
    if (attempt.status !== "in_progress") return { saved: false, reason: "submitted" as const }
    const now = Date.now()
    if (now > attempt.deadlineAt + EXAM_DEADLINE_GRACE_MS)
      return { saved: false, reason: "expired" as const }
    const paper = await ctx.db.get(attempt.paperId)
    if (!paper) throw new Error("Paper not found")
    await ctx.db.patch(attemptId, {
      answers: sanitizeAnswers(paper.questions, answers),
      updatedAt: now,
    })
    return { saved: true, reason: null }
  },
})

/** The choice answers of a submitted attempt, for recording as study evidence. */
function choiceEvidence(paper: Doc<"examPapers">, attempt: Doc<"examAttempts">) {
  const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]))
  return paper.questions.flatMap((question) => {
    const selected = answers.get(question.id)?.selectedOptionIds ?? []
    if (!question.itemId || !isChoiceType(question.type) || !selected.length) return []
    return [
      {
        questionId: question.id,
        itemId: question.itemId,
        type: question.type as "single-choice" | "multiple-answer" | "true-false",
        selectedOptionIds: selected,
      },
    ]
  })
}

/**
 * Submits an attempt: saves the final answers (unless time ran out more
 * than the grace period ago), marks choice questions, and starts grading
 * when written answers need it. Submitting twice returns the first result.
 * Called by the submit route, which records the choice answers as evidence
 * and runs the grading.
 */
export const submitAttempt = mutation({
  args: {
    attemptId: v.id("examAttempts"),
    answers: v.optional(v.array(examAnswerFields)),
    /** True when the browser submitted because the countdown reached zero. */
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, { attemptId, answers, auto }) => {
    const attempt = await ctx.db.get(attemptId)
    if (!attempt) throw new Error("Attempt not found")
    const paper = await ctx.db.get(attempt.paperId)
    if (!paper) throw new Error("Paper not found")
    if (attempt.status === "submitted")
      return {
        projectId: attempt.projectId,
        submittedAt: attempt.submittedAt ?? attempt.updatedAt,
        gradingStartedAt: null,
        evidence: choiceEvidence(paper, attempt),
      }
    const now = Date.now()
    const finalAnswers =
      answers && now <= attempt.deadlineAt + EXAM_DEADLINE_GRACE_MS
        ? sanitizeAnswers(paper.questions, answers)
        : attempt.answers
    const questions = scorable(paper.questions)
    const results = scoreAttempt(questions, finalAnswers)
    const needsGrading = results.some((result) => result.outcome === "pending")
    const totals = attemptTotals(questions, results)
    await ctx.db.patch(attemptId, {
      status: "submitted",
      answers: finalAnswers,
      submittedAt: now,
      updatedAt: now,
      autoSubmitted: Boolean(auto) || now > attempt.deadlineAt,
      results,
      gradingStatus: needsGrading ? "running" : "not_needed",
      ...(needsGrading ? { gradingStartedAt: now } : {}),
      awardedMarks: totals.awarded,
      availableMarks: totals.available,
    })
    const submitted = (await ctx.db.get(attemptId))!
    return {
      projectId: attempt.projectId,
      submittedAt: now,
      gradingStartedAt: needsGrading ? now : null,
      evidence: choiceEvidence(paper, submitted),
    }
  },
})

/**
 * Supplies the grading run with each written answer waiting for marks, its
 * mark scheme, and its model answer. Server-only.
 */
export const gradingContext = query({
  args: { attemptId: v.id("examAttempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId)
    if (!attempt || attempt.status !== "submitted") return null
    const paper = await ctx.db.get(attempt.paperId)
    const project = paper ? await ctx.db.get(paper.projectId) : null
    if (!paper || !project) return null
    const pending = new Set(
      (attempt.results ?? [])
        .filter((result) => result.outcome === "pending")
        .map((result) => result.questionId)
    )
    const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]))
    return {
      moduleTitle: project.title,
      paperTitle: paper.title,
      items: paper.questions
        .filter((question) => pending.has(question.id) && question.type === "written")
        .map((question) => ({
          id: question.id,
          number: question.number,
          marks: question.marks,
          prompt: question.prompt,
          modelAnswer: question.modelAnswer ?? "",
          markScheme: question.markScheme ?? [],
          answer: answers.get(question.id)?.text ?? "",
        })),
    }
  },
})

/**
 * Restarts marking written answers after a failed or stopped grading run.
 * @returns The new `gradingStartedAt`, or null when nothing should start.
 */
export const restartGrading = mutation({
  args: { attemptId: v.id("examAttempts") },
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId)
    if (!attempt || attempt.status !== "submitted") throw new Error("Attempt not found")
    const now = Date.now()
    if (gradingStatus(attempt, now).status !== "failed") return { gradingStartedAt: null }
    await ctx.db.patch(attemptId, {
      gradingStatus: "running",
      gradingStartedAt: now,
      gradingError: undefined,
    })
    return { gradingStartedAt: now }
  },
})

/**
 * Saves marks and feedback for every written answer that was waiting.
 * Marks are clamped to each question's maximum. Ignored when a newer
 * grading run has started.
 */
export const saveGrades = mutation({
  args: {
    attemptId: v.id("examAttempts"),
    gradingStartedAt: v.number(),
    grades: v.array(v.object({ id: v.string(), marks: v.number(), feedback: v.string() })),
  },
  handler: async (ctx, { attemptId, gradingStartedAt, grades }) => {
    const attempt = await ctx.db.get(attemptId)
    if (
      !attempt ||
      attempt.gradingStatus !== "running" ||
      attempt.gradingStartedAt !== gradingStartedAt
    )
      return { saved: false }
    const paper = await ctx.db.get(attempt.paperId)
    if (!paper) throw new Error("Paper not found")
    const marksById = new Map(paper.questions.map((question) => [question.id, question.marks]))
    const gradeById = new Map(grades.map((grade) => [grade.id, grade]))
    const results: ExamQuestionResult[] = (attempt.results ?? []).map((result) => {
      const grade = gradeById.get(result.questionId)
      const max = marksById.get(result.questionId)
      if (result.outcome !== "pending" || !grade || max === undefined) return result
      return {
        questionId: result.questionId,
        outcome: "marked",
        awardedMarks: clampMarks(grade.marks, max),
        feedback: grade.feedback.trim().slice(0, EXAM_LIMITS.feedbackChars),
      }
    })
    if (results.some((result) => result.outcome === "pending"))
      throw new Error("Some written answers have no marks")
    const totals = attemptTotals(scorable(paper.questions), results)
    await ctx.db.patch(attemptId, {
      results,
      gradingStatus: "completed",
      gradingError: undefined,
      gradedAt: Date.now(),
      awardedMarks: totals.awarded,
      availableMarks: totals.available,
    })
    return { saved: true }
  },
})

/** Marks a grading run failed with a learner-facing message, unless a newer run has started. */
export const failGrading = mutation({
  args: { attemptId: v.id("examAttempts"), gradingStartedAt: v.number(), error: v.string() },
  handler: async (ctx, { attemptId, gradingStartedAt, error }) => {
    const attempt = await ctx.db.get(attemptId)
    if (
      !attempt ||
      attempt.gradingStatus !== "running" ||
      attempt.gradingStartedAt !== gradingStartedAt
    )
      return
    await ctx.db.patch(attemptId, {
      gradingStatus: "failed",
      gradingError: error.slice(0, 300),
      gradedAt: Date.now(),
    })
  },
})
