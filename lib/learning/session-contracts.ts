/**
 * Defines the portable data exchanged by deliberate study and test sessions.
 *
 * These contracts contain no React, Convex, or browser APIs. Web and React
 * Native clients can use the same answer identity and result helpers while the
 * server remains the only place that evaluates correctness.
 */

/** Question formats permitted in a deliberate session. */
export type SessionQuestionType =
  "single-choice" | "multiple-answer" | "true-false"

/** A question deck item with no answer key or post-answer explanation. */
export interface SessionQuestion {
  /** Learning-item identifier used when submitting an answer. */
  readonly itemId: string
  /** Concept identifier used to group review evidence. */
  readonly conceptId: string
  /** Optional topic identifier for a project-scoped deck. */
  readonly topicId?: string
  /** Question format used to render and normalize the answer. */
  readonly type: SessionQuestionType
  /** Short label shown above the prompt. */
  readonly title: string
  /** Question text shown before the answer is submitted. */
  readonly prompt: string
  /** Options for single-choice and multiple-answer questions. */
  readonly options?: readonly SessionOption[]
  /** Stable generation order used for deterministic decks. */
  readonly order?: number
}

/** One selectable option in a session question. */
export interface SessionOption {
  /** Stable option identifier sent in an answer. */
  readonly id: string
  /** Text shown to the learner. */
  readonly text: string
}

/** Answer values accepted by the normal session question formats. */
export type SessionAnswer = string | boolean | readonly string[]

/** One idempotent answer submission sent to the server. */
export interface SessionAnswerSubmission {
  /** Stable identifier reused when a request is retried or resumed. */
  readonly attemptId: string
  /** Learning item being answered. */
  readonly itemId: string
  /** Answer selected by the learner. */
  readonly answer: SessionAnswer
  /** Client event time kept stable across retries of this attempt. */
  readonly occurredAt: number
}

/** Feedback returned after a valid server-scored answer. */
export interface SessionFeedback {
  /** Post-answer explanation stored with the learning item. */
  readonly body?: string
  /** Correct option for a single-choice question, when applicable. */
  readonly correctOptionId?: string
  /** Complete correct option set for a multiple-answer question. */
  readonly correctOptionIds?: readonly string[]
  /** Correct boolean answer for a true-false question. */
  readonly correctAnswer?: boolean
}

/** Result for one answer, including feedback only after server scoring. */
export interface SessionAnswerResult {
  /** Attempt identity used for idempotent retries. */
  readonly attemptId: string
  /** Learning item that was scored. */
  readonly itemId: string
  /** Server result, or invalid when the payload could not be scored. */
  readonly status: "correct" | "incorrect" | "invalid"
  /** True only when the server scored the answer as correct. */
  readonly isCorrect: boolean
  /** Whether this response came from an already recorded event. */
  readonly alreadyRecorded?: boolean
  /** Explanation and correct answer details revealed after scoring. */
  readonly feedback?: SessionFeedback
  /** Safe reason for an invalid answer, when supplied by the server. */
  readonly reason?: string
}

/** Result page returned by the bounded study-deck query. */
export interface SessionQuestionPage {
  /** Question-only items safe to render before an answer. */
  readonly items: readonly SessionQuestion[]
  /** Whether the server reached the end of its bounded scan. */
  readonly isDone: boolean
  /** Cursor for clients that want to continue a limited initial deck. */
  readonly continueCursor: string
}

/** Counts useful progress and deliberately ignores unanswered questions. */
export interface SessionProgress {
  /** Total questions in the session deck. */
  readonly total: number
  /** Questions with a locally selected answer. */
  readonly answered: number
  /** Questions intentionally left unanswered. */
  readonly unanswered: number
}

/** Counts server-scored results shown on a completed test. */
export interface SessionResultSummary {
  /** Number of questions in the session deck. */
  readonly total: number
  /** Number of valid answers received from the server. */
  readonly scored: number
  /** Number of correct server results. */
  readonly correct: number
  /** Number of incorrect server results. */
  readonly incorrect: number
  /** Number of submitted answers the server rejected as invalid. */
  readonly invalid: number
  /** Number of unanswered questions, which do not count as wrong. */
  readonly unanswered: number
}

/**
 * Creates an idempotency key stable for one session, item, and answer.
 *
 * The caller should keep the session identifier stable when recovering a
 * partially submitted test. Empty or excessively long identifiers are
 * rejected so this contract cannot create unbounded request fields.
 */
export function createAttemptId(
  sessionId: string,
  itemId: string,
  answer?: SessionAnswer
): string {
  const session = requireIdentifier(sessionId, "Session ID")
  const item = requireIdentifier(itemId, "Item ID")
  const attemptId = `attempt_${session}_${item}_${answerFingerprint(answer)}`
  if (attemptId.length > 400) throw new Error("Attempt ID is too long")
  return attemptId
}

/** Returns a progress count without treating skipped questions as failures. */
export function getSessionProgress(
  questions: readonly SessionQuestion[],
  answers: Readonly<Record<string, SessionAnswer | undefined>>
): SessionProgress {
  const answered = questions.reduce(
    (count, question) =>
      answers[question.itemId] === undefined ? count : count + 1,
    0
  )
  return {
    total: questions.length,
    answered,
    unanswered: questions.length - answered,
  }
}

/** Builds a submission while preserving a caller-owned attempt timestamp. */
export function makeAnswerSubmission(
  sessionId: string,
  question: SessionQuestion,
  answer: SessionAnswer,
  occurredAt: number
): SessionAnswerSubmission {
  if (!Number.isFinite(occurredAt) || occurredAt < 0)
    throw new Error("Occurred time must be a finite non-negative number")
  return {
    attemptId: createAttemptId(sessionId, question.itemId, answer),
    itemId: question.itemId,
    answer,
    occurredAt,
  }
}

/** Summarizes scored results while keeping unanswered items separate. */
export function summarizeSessionResults(
  total: number,
  results: readonly SessionAnswerResult[],
  unanswered: number
): SessionResultSummary {
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error("Session total must be a non-negative integer")
  if (!Number.isSafeInteger(unanswered) || unanswered < 0 || unanswered > total)
    throw new Error("Unanswered count is outside the session bounds")
  const correct = results.filter((result) => result.status === "correct").length
  const incorrect = results.filter(
    (result) => result.status === "incorrect"
  ).length
  const invalid = results.filter((result) => result.status === "invalid").length
  return {
    total,
    scored: correct + incorrect,
    correct,
    incorrect,
    invalid,
    unanswered,
  }
}

/** Requires one compact identifier for a portable request contract. */
function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > 200) throw new Error(`${label} is too long`)
  return trimmed
}

/** Produces a compact deterministic answer suffix for retry-safe event keys. */
function answerFingerprint(answer: SessionAnswer | undefined): string {
  if (answer === undefined) return "pending"
  const canonical = Array.isArray(answer)
    ? [...answer].sort().join("\u001f")
    : String(answer)
  let hash = 2_166_136_261
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}
