/**
 * Scores exam attempts and summarises them by concept.
 *
 * Choice questions are marked deterministically here, inside the Convex
 * mutation that submits an attempt, so the browser can never mark its own
 * paper. Written answers stay `pending` until the grading run awards marks.
 * When the learner edits or deletes a question, the helpers at the end of
 * this file carry saved answers across the change and mark earlier attempts
 * again. Dependency-free so Convex functions, route handlers, and the client share
 * one set of rules and limits. Prompts and model-output validation live in
 * `lib/exam.ts`.
 */

/** Question formats an exam paper can hold. */
export type ExamQuestionType = "single-choice" | "multiple-answer" | "true-false" | "written"

/** Most questions one paper may hold; extra questions are dropped and counted. */
export const MAX_PAPER_QUESTIONS = 60

/** Mock exam lengths the learner can choose, in minutes. */
export const MOCK_EXAM_MINUTES = [30, 60, 90] as const

/** One of the allowed mock exam lengths. */
export type MockExamMinutes = (typeof MOCK_EXAM_MINUTES)[number]

/** Paper length offered when a past paper does not state one, in minutes. */
export const DEFAULT_EXAM_MINUTES = 60

/** Bounds on every string and list in a validated exam question and grade. */
export const EXAM_LIMITS = {
  titleChars: 120,
  numberChars: 20,
  promptChars: 4_000,
  conceptChars: 120,
  /** Lesson quiz limits, which exam choice questions reuse. */
  optionChars: 1_000,
  explanationChars: 2_000,
  maxOptions: 6,
  modelAnswerChars: 4_000,
  markPointChars: 400,
  maxMarkPoints: 10,
  feedbackChars: 1_000,
  minFeedbackChars: 10,
  minDurationMinutes: 5,
  maxDurationMinutes: 600,
  maxStatedTotalMarks: 1_000,
} as const

/** Lowest and highest marks one question may carry. Marks are whole or half numbers. */
export const EXAM_MARK_RANGE = { min: 0.5, max: 100 } as const

/** Longest written answer stored for one question, in characters. */
export const MAX_WRITTEN_ANSWER_CHARS = 8_000

/** How long after the deadline answers are still accepted, to absorb network delay. */
export const EXAM_DEADLINE_GRACE_MS = 60_000

/** The fields scoring needs from a question. */
export type ScorableQuestion = {
  id: string
  type: ExamQuestionType
  marks: number
  /** Option ids that make a choice answer correct; unused for written questions. */
  correctOptionIds?: string[]
  /** Options offered for choice questions, used to discard unknown selections. */
  options?: Array<{ id: string }>
}

/** A learner's answer to one question, as autosaved during the attempt. */
export type ExamAnswer = {
  questionId: string
  selectedOptionIds?: string[]
  text?: string
}

/**
 * How one question went.
 *
 * - `unanswered`: nothing was chosen or written; worth no marks, but shown
 *   apart from a wrong answer.
 * - `correct` / `incorrect`: a choice question, marked all or nothing.
 * - `pending`: a written answer waiting for the grading run.
 * - `marked`: a written answer the grading run has awarded marks to.
 */
export type ExamOutcome = "unanswered" | "correct" | "incorrect" | "pending" | "marked"

/** The marking result for one question. `awardedMarks` is unset while pending. */
export type ExamQuestionResult = {
  questionId: string
  outcome: ExamOutcome
  awardedMarks?: number
  feedback?: string
}

/** Returns whether a question is answered by choosing options. */
export function isChoiceType(type: ExamQuestionType): boolean {
  return type !== "written"
}

/**
 * Rounds marks to the nearest half and keeps them within `0..max`.
 * Non-finite values become zero, so a malformed grade can never add marks.
 */
export function clampMarks(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  const rounded = Math.round(value * 2) / 2
  return Math.min(Math.max(rounded, 0), max)
}

/** Returns the learner's selection limited to the question's real options, in option order. */
function validSelection(question: ScorableQuestion, answer: ExamAnswer | undefined): string[] {
  const chosen = new Set(answer?.selectedOptionIds ?? [])
  return (question.options ?? []).map((option) => option.id).filter((id) => chosen.has(id))
}

/** Returns whether the learner gave any answer to a question. */
export function isAnswered(question: ScorableQuestion, answer: ExamAnswer | undefined): boolean {
  if (!answer) return false
  return isChoiceType(question.type)
    ? validSelection(question, answer).length > 0
    : Boolean(answer.text?.trim())
}

/**
 * Marks one choice question all or nothing: correct only when the selection
 * matches every correct option and no other, as in lesson quizzes.
 */
export function scoreChoiceAnswer(
  question: ScorableQuestion,
  answer: ExamAnswer | undefined
): ExamQuestionResult {
  const selected = validSelection(question, answer)
  if (!selected.length) return { questionId: question.id, outcome: "unanswered", awardedMarks: 0 }
  const correct = new Set(question.correctOptionIds ?? [])
  const isCorrect = correct.size > 0 && selected.length === correct.size && selected.every((id) => correct.has(id))
  return {
    questionId: question.id,
    outcome: isCorrect ? "correct" : "incorrect",
    awardedMarks: isCorrect ? question.marks : 0,
  }
}

/**
 * Marks every question that can be marked without a model: choice questions
 * are scored, blank written answers get zero, and answered written questions
 * are left `pending` for the grading run.
 * @returns One result per question, in paper order.
 */
export function scoreAttempt(
  questions: ScorableQuestion[],
  answers: ExamAnswer[]
): ExamQuestionResult[] {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]))
  return questions.map((question) => {
    const answer = byQuestion.get(question.id)
    if (isChoiceType(question.type)) return scoreChoiceAnswer(question, answer)
    if (!isAnswered(question, answer))
      return { questionId: question.id, outcome: "unanswered", awardedMarks: 0 }
    return { questionId: question.id, outcome: "pending" }
  })
}

/** Score totals for an attempt. */
export type AttemptTotals = {
  /** Marks awarded so far. */
  awarded: number
  /** Marks available on the whole paper. */
  available: number
  /** Marks still waiting for the grading run. */
  pending: number
  /** `awarded / available` as a whole percentage, or null for an empty paper. */
  percentage: number | null
}

/** Adds up awarded, available, and pending marks for an attempt. */
export function attemptTotals(
  questions: Array<Pick<ScorableQuestion, "id" | "marks">>,
  results: ExamQuestionResult[]
): AttemptTotals {
  const byQuestion = new Map(results.map((result) => [result.questionId, result]))
  let awarded = 0
  let available = 0
  let pending = 0
  for (const question of questions) {
    available += question.marks
    const result = byQuestion.get(question.id)
    if (!result || result.awardedMarks === undefined) pending += question.marks
    else awarded += result.awardedMarks
  }
  return {
    awarded,
    available,
    pending,
    percentage: available > 0 ? Math.round((awarded / available) * 100) : null,
  }
}

/** One concept's share of an attempt, for the results breakdown. */
export type ConceptBreakdownRow = {
  concept: string
  /** Unit the concept belongs to, when the paper matched one. */
  unitId?: string
  awarded: number
  available: number
  /** Questions on this concept that were left blank. */
  unanswered: number
  questionCount: number
  /** Whole percentage of available marks awarded. */
  percentage: number
}

/**
 * Groups marked questions by concept and sorts the weakest first: lowest
 * percentage, then the most marks at stake, then by name. Questions still
 * waiting for marking are left out so they do not look like lost marks.
 */
export function conceptBreakdown(
  questions: Array<Pick<ScorableQuestion, "id" | "marks"> & { concept: string; unitId?: string }>,
  results: ExamQuestionResult[]
): ConceptBreakdownRow[] {
  const byQuestion = new Map(results.map((result) => [result.questionId, result]))
  const rows = new Map<string, ConceptBreakdownRow>()
  for (const question of questions) {
    const result = byQuestion.get(question.id)
    if (!result || result.awardedMarks === undefined) continue
    const concept = question.concept.replace(/\s+/g, " ").trim() || "General"
    const key = concept.toLowerCase()
    const row = rows.get(key) ?? {
      concept,
      ...(question.unitId ? { unitId: question.unitId } : {}),
      awarded: 0,
      available: 0,
      unanswered: 0,
      questionCount: 0,
      percentage: 0,
    }
    if (!row.unitId && question.unitId) row.unitId = question.unitId
    row.awarded += result.awardedMarks
    row.available += question.marks
    row.questionCount += 1
    if (result.outcome === "unanswered") row.unanswered += 1
    rows.set(key, row)
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      percentage: row.available > 0 ? Math.round((row.awarded / row.available) * 100) : 0,
    }))
    .sort((a, b) => {
      const ratioA = a.available ? a.awarded / a.available : 0
      const ratioB = b.available ? b.awarded / b.available : 0
      return ratioA - ratioB || b.available - a.available || a.concept.localeCompare(b.concept)
    })
}

/**
 * Builds the mapping from a choice question's option ids before an edit to
 * its ids after it, so saved selections keep pointing at the same option when
 * options are added, removed, or reworded.
 * @param previousIds For each option after the edit, in order, the id it had
 *   before, or null for a new option.
 * @param nextIds Option ids after the edit, in the same order.
 * @param currentIds Option ids before the edit.
 * @returns Old id to new id, with removed options absent; or null when the
 *   lists differ in length, name an unknown option, or name one option twice.
 */
export function optionIdMap(
  previousIds: Array<string | null>,
  nextIds: string[],
  currentIds: string[]
): Map<string, string> | null {
  if (previousIds.length !== nextIds.length) return null
  const known = new Set(currentIds)
  const map = new Map<string, string>()
  for (const [index, previous] of previousIds.entries()) {
    if (previous === null) continue
    if (!known.has(previous) || map.has(previous)) return null
    map.set(previous, nextIds[index])
  }
  return map
}

/**
 * Applies an edit or deletion of one question to an attempt's saved answers.
 * @param map Option id map for an edited choice question, or null when the
 *   question was deleted and its answer should be dropped.
 * @returns New answers; other questions' answers are unchanged.
 */
export function remapAnswers(
  answers: ExamAnswer[],
  questionId: string,
  map: Map<string, string> | null
): ExamAnswer[] {
  return answers.flatMap((answer) => {
    if (answer.questionId !== questionId) return [answer]
    if (!map) return []
    const selected = (answer.selectedOptionIds ?? []).flatMap((id) => {
      const next = map.get(id)
      return next === undefined ? [] : [next]
    })
    return [{ ...answer, selectedOptionIds: selected }]
  })
}

/**
 * Marks a submitted attempt again after its paper's questions changed.
 *
 * Choice questions are marked again against the current answer key, which is
 * deterministic, so unchanged questions keep their result. Written answers
 * keep the marks and feedback they were given, clamped to the question's
 * current marks, because re-marking them would need another model run; ones
 * still waiting for marking stay pending. Results for questions no longer on
 * the paper are dropped.
 * @returns One result per current question, in paper order.
 */
export function rescoreResults(
  questions: ScorableQuestion[],
  answers: ExamAnswer[],
  results: ExamQuestionResult[]
): ExamQuestionResult[] {
  const answerById = new Map(answers.map((answer) => [answer.questionId, answer]))
  const resultById = new Map(results.map((result) => [result.questionId, result]))
  return questions.map((question) => {
    const answer = answerById.get(question.id)
    if (isChoiceType(question.type)) return scoreChoiceAnswer(question, answer)
    const result = resultById.get(question.id)
    if (!result) return scoreAttempt([question], answer ? [answer] : [])[0]
    return result.awardedMarks === undefined
      ? result
      : { ...result, awardedMarks: clampMarks(result.awardedMarks, question.marks) }
  })
}

/** The parts of a question that decide what counts as the right answer. */
export type ExamAnswerKey = {
  type: ExamQuestionType
  correctOptionIds?: string[]
  modelAnswer?: string
  markScheme?: Array<{ point: string; marks: number }>
}

/**
 * Returns whether an edit changed a question's answer: its format, its
 * correct options (compared through the option id map, so moving options
 * around is not a change), its model answer, or its mark scheme.
 * @param map Option id map for a choice question; ids map to themselves when omitted.
 */
export function answerKeyChanged(
  before: ExamAnswerKey,
  after: ExamAnswerKey,
  map?: Map<string, string>
): boolean {
  if (before.type !== after.type) return true
  if (isChoiceType(before.type)) {
    const previous = (before.correctOptionIds ?? []).map((id) => (map ? map.get(id) : id))
    const next = new Set(after.correctOptionIds ?? [])
    return previous.length !== next.size || previous.some((id) => id === undefined || !next.has(id))
  }
  const scheme = (key: ExamAnswerKey) =>
    JSON.stringify((key.markScheme ?? []).map((point) => [point.point.trim(), point.marks]))
  return (
    (before.modelAnswer ?? "").trim() !== (after.modelAnswer ?? "").trim() ||
    scheme(before) !== scheme(after)
  )
}
