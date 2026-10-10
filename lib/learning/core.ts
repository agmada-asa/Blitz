/**
 * Defines Blitz's portable learning contracts and the small deterministic
 * rules used to evaluate answers, update concept review state, and choose a
 * mixed home-feed batch.
 *
 * This module only works with plain data. It can be imported by the browser,
 * React Native, or a server adapter without bringing in a framework or a
 * persistence client.
 */

/** The question formats supported in ordinary Blitz study flows. */
export type StandardQuestionType =
  | "single-choice"
  | "multiple-answer"
  | "true-false"
  | StructuredQuestionType

/**
 * Question formats answered with an ordered list of strings rather than a
 * choice: typed blanks, a sequence, pairs, or a program's output.
 */
export type StructuredQuestionType =
  "cloze" | "ordering" | "matching" | "code-output"

/** Every structured question type, for runtime checks. */
export const STRUCTURED_QUESTION_TYPES: readonly StructuredQuestionType[] = [
  "cloze",
  "ordering",
  "matching",
  "code-output",
]

/** Returns whether a stored type is one of the structured question types. */
export function isStructuredQuestionType(
  type: string
): type is StructuredQuestionType {
  return (STRUCTURED_QUESTION_TYPES as readonly string[]).includes(type)
}

/** Question types whose answer order is meaningful, so idempotency checks must not sort it. */
export function answerOrderMatters(type: string): boolean {
  return isStructuredQuestionType(type)
}

/** Identifies where a question may be shown. */
export type QuestionContext = "feed" | "project-activity"

/** A selectable answer and its stable identifier. */
export interface QuestionOption {
  /** Stable identifier used in answers and persisted events. */
  readonly id: string
  /** Text displayed for this option. */
  readonly text: string
}

/** Fields shared by all question variants. */
export interface BaseQuestion {
  /** Stable identifier for the question. */
  readonly id: string
  /** Stable concept identifier used to group review evidence. */
  readonly conceptId: string
  /** Prompt shown to the learner. */
  readonly prompt: string
  /** Flow in which the question is available. */
  readonly context?: QuestionContext
}

/** A question with exactly one correct option. */
export interface SingleChoiceQuestion extends BaseQuestion {
  readonly type: "single-choice"
  readonly options: readonly QuestionOption[]
  readonly correctOptionId: string
}

/** A question where the complete set of correct options must be selected. */
export interface MultipleAnswerQuestion extends BaseQuestion {
  readonly type: "multiple-answer"
  readonly options: readonly QuestionOption[]
  readonly correctOptionIds: readonly string[]
}

/** A binary question with a boolean answer. */
export interface TrueFalseQuestion extends BaseQuestion {
  readonly type: "true-false"
  readonly correctAnswer: boolean
}

/** A written question reserved for an explicitly selected project activity. */
export interface WrittenQuestion extends BaseQuestion {
  readonly type: "written"
  readonly context: "project-activity"
  /** Accepted answers after conservative text normalization. */
  readonly acceptedAnswers: readonly string[]
}

/**
 * A prompt with numbered blanks (`{{1}}`, `{{2}}`, …) typed by the learner.
 * Each blank accepts any of its listed answers after `normalizeBlankAnswer`.
 */
export interface ClozeQuestion extends BaseQuestion {
  readonly type: "cloze"
  /** Accepted answers per blank, in blank order. */
  readonly acceptedAnswers: readonly (readonly string[])[]
}

/** Items to put in order; `options` is the display order, `correctOrder` the answer. */
export interface OrderingQuestion extends BaseQuestion {
  readonly type: "ordering"
  readonly options: readonly QuestionOption[]
  /** Every option id, in the correct order. */
  readonly correctOrder: readonly string[]
}

/** Prompts each matched to one option; options may include unused extras. */
export interface MatchingQuestion extends BaseQuestion {
  readonly type: "matching"
  /** Left-hand items, in display order. */
  readonly prompts: readonly string[]
  readonly options: readonly QuestionOption[]
  /** The option id that matches each prompt, in prompt order. */
  readonly correctOptionIds: readonly string[]
}

/** A program whose exact output the learner types. */
export interface CodeOutputQuestion extends BaseQuestion {
  readonly type: "code-output"
  /** Accepted outputs, compared after `normalizeOutputAnswer`. */
  readonly acceptedOutputs: readonly string[]
}

/** Every question the learning core can evaluate. */
export type Question =
  | SingleChoiceQuestion
  | MultipleAnswerQuestion
  | TrueFalseQuestion
  | WrittenQuestion
  | ClozeQuestion
  | OrderingQuestion
  | MatchingQuestion
  | CodeOutputQuestion

/** A scalar or structured answer accepted by the normal question formats. */
export type AnswerInput =
  | string
  | boolean
  | readonly string[]
  | { readonly optionId: string }
  | { readonly optionIds: readonly string[] }

/** Why an answer could not be scored as correct or incorrect. */
export type InvalidAnswerReason =
  | "missing-answer"
  | "wrong-answer-shape"
  | "unknown-option"
  | "duplicate-option"
  | "invalid-question"
  | "incomplete-answer"

/** The normalized result of evaluating a learner answer. */
export interface AnswerEvaluation {
  /** Correct, incorrect, or invalid when the input cannot be scored. */
  readonly status: "correct" | "incorrect" | "invalid"
  /** Convenient boolean for callers that only need scored correctness. */
  readonly isCorrect: boolean
  /** Reason for an invalid result, omitted for scored answers. */
  readonly reason?: InvalidAnswerReason
  /** Canonical answer value when the input passed shape validation. */
  readonly normalizedAnswer?: string | boolean | readonly string[]
}

/** A compact, persisted summary of evidence for one concept. */
export interface ConceptReviewState {
  /** Stable concept identifier. */
  readonly conceptId: string
  /** Number of answer events recorded for this concept. */
  readonly attemptCount: number
  /** Number of correct answer events. */
  readonly correctCount: number
  /** Number of incorrect answer events. */
  readonly incorrectCount: number
  /** Number of consecutive correct answer events at the latest point. */
  readonly consecutiveCorrect: number
  /** Timestamp of the latest scored answer, or null before first answer. */
  readonly lastAttemptAt: number | null
  /** Timestamp at which the concept becomes due for another review. */
  readonly dueAt: number
  /** Latest scored outcome, or null before first answer. */
  readonly lastOutcome: "correct" | "incorrect" | null
}

/** A scored answer event that may change review scheduling. */
export interface AnswerReviewEvent {
  readonly type: "answer"
  readonly outcome: "correct" | "incorrect"
  readonly occurredAt: number
}

/** A passive event that deliberately leaves review evidence unchanged. */
export interface PassiveReviewEvent {
  readonly type: "skip" | "exposure"
  readonly occurredAt: number
}

/** Events accepted by the review-state reducer. */
export type ReviewEvent = AnswerReviewEvent | PassiveReviewEvent

/** A candidate item that introduces material without review evidence. */
export interface NewFeedItem {
  /** Stable item identifier. */
  readonly id: string
  /** Project owning the item. */
  readonly projectId: string
  /** Optional topic used by topic filters. */
  readonly topicId?: string
  /** Concept introduced or explained by the item. */
  readonly conceptId: string
  readonly kind: "new"
  /** Optional presentation format used for explanation/question interleaving. */
  readonly format?: FeedItemFormat
  /** Creation time used to keep new material in a stable order. */
  readonly createdAt: number
  /** Optional producer order for deterministic deck ordering. */
  readonly order?: number
}

/** A candidate item that revisits a concept with existing review evidence. */
export interface ReviewFeedItem {
  /** Stable item identifier. */
  readonly id: string
  /** Project owning the item. */
  readonly projectId: string
  /** Optional topic used by topic filters. */
  readonly topicId?: string
  /** Concept introduced or explained by the item. */
  readonly conceptId: string
  readonly kind: "review"
  /** Optional presentation format used for explanation/question interleaving. */
  readonly format?: FeedItemFormat
  /** Creation time used as a stable tie breaker. */
  readonly createdAt: number
  /** Optional producer order for deterministic deck ordering. */
  readonly order?: number
  /** Review state that determines whether this item is due. */
  readonly reviewState: ConceptReviewState
}

/** Candidate item accepted by the feed selector. */
export type FeedItem = NewFeedItem | ReviewFeedItem

/** Presentation format used to keep explanations and questions interleaved. */
export type FeedItemFormat = "explanation" | "question"

/** Inputs for selecting a bounded, filtered home-feed batch. */
export interface FeedSelectionOptions {
  /** Candidate material from all available projects. */
  readonly items: readonly FeedItem[]
  /** Current timestamp used for due checks. */
  readonly now: number
  /** Maximum number of items to return. */
  readonly limit: number
  /** Optional project allow-list. An empty list means no project filter. */
  readonly projectIds?: readonly string[]
  /** Optional topic allow-list. An empty list means no topic filter. */
  readonly topicIds?: readonly string[]
  /** Optional single-project shorthand. */
  readonly projectId?: string
  /** Optional single-topic shorthand. */
  readonly topicId?: string
  /** Concept shown immediately before this batch, if any. */
  readonly previousConceptId?: string
  /** Recently shown concepts, used as a soft preference when alternatives exist. */
  readonly recentConceptIds?: readonly string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const INCORRECT_RETRY_MS = 10 * 60 * 1000
const CORRECT_INTERVALS_MS = [
  DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS,
  14 * DAY_MS,
  30 * DAY_MS,
] as const

/** Checks that a value is a finite timestamp. */
function isTimestamp(value: number): boolean {
  return Number.isFinite(value)
}

/** Creates a review state with no scored evidence and immediate initial due time. */
export function createReviewState(
  conceptId: string,
  now: number
): ConceptReviewState {
  if (!conceptId.trim()) throw new Error("Concept id must not be empty")
  if (!isTimestamp(now)) throw new Error("Review timestamp must be finite")
  return {
    conceptId,
    attemptCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    consecutiveCorrect: 0,
    lastAttemptAt: null,
    dueAt: now,
    lastOutcome: null,
  }
}

/** Returns true when a concept's scheduled review is due at the supplied time. */
export function isReviewDue(state: ConceptReviewState, now: number): boolean {
  if (!isTimestamp(now)) throw new Error("Review timestamp must be finite")
  return state.dueAt <= now
}

/** Returns the interval for a correct answer based on the updated streak. */
function intervalAfterCorrect(consecutiveCorrect: number): number {
  const index = Math.min(consecutiveCorrect, CORRECT_INTERVALS_MS.length) - 1
  return CORRECT_INTERVALS_MS[Math.max(index, 0)]
}

/** Applies one review event without mutating the input state. */
export function applyReviewEvent(
  state: ConceptReviewState,
  event: ReviewEvent
): ConceptReviewState {
  if (!isTimestamp(event.occurredAt))
    throw new Error("Review timestamp must be finite")
  if (event.type === "skip" || event.type === "exposure") return state
  if (event.type !== "answer") return state
  if (event.occurredAt < (state.lastAttemptAt ?? -Infinity)) {
    // A late answer uses the latest known clock point so sync cannot rewind a due date.
    return applyReviewEvent(state, {
      ...event,
      occurredAt: state.lastAttemptAt ?? event.occurredAt,
    })
  }
  const correct = event.outcome === "correct"
  const consecutiveCorrect = correct ? state.consecutiveCorrect + 1 : 0
  return {
    ...state,
    attemptCount: state.attemptCount + 1,
    correctCount: state.correctCount + (correct ? 1 : 0),
    incorrectCount: state.incorrectCount + (correct ? 0 : 1),
    consecutiveCorrect,
    lastAttemptAt: event.occurredAt,
    dueAt:
      event.occurredAt +
      (correct ? intervalAfterCorrect(consecutiveCorrect) : INCORRECT_RETRY_MS),
    lastOutcome: event.outcome,
  }
}

/** Applies a scored answer outcome using the same reducer as synced events. */
export function recordReviewOutcome(
  state: ConceptReviewState,
  outcome: "correct" | "incorrect",
  occurredAt: number
): ConceptReviewState {
  return applyReviewEvent(state, { type: "answer", outcome, occurredAt })
}

/** Normalizes written text conservatively for exact accepted-answer matching. */
export function normalizeTextAnswer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Normalizes one typed blank for matching: case, surrounding quotes or
 * backticks, a trailing full stop inside or outside them, and spacing are
 * ignored, so `O(n)`, "`o(n)`", "O( n )." and `"O(n)".` all match. Unicode is NFKC-folded so pasted
 * symbols compare equal to typed ones.
 */
export function normalizeBlankAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\.$/, "")
    .replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .replace(/\s+/g, "")
    .toLowerCase()
}

/**
 * Normalizes program output for matching: line endings, trailing spaces,
 * runs of spaces, and leading or trailing blank lines are ignored; case and
 * line breaks still count, because they are part of the output.
 */
export function normalizeOutputAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
}

/** Returns how many numbered blanks (`{{n}}`) a cloze prompt contains. */
export function countClozeBlanks(prompt: string): number {
  const numbers = new Set(
    [...prompt.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((match) => Number(match[1]))
  )
  return numbers.size
}

/** Gets a list of strings from an answer, or undefined for another shape. */
function stringListAnswer(
  answer: AnswerInput | undefined
): readonly string[] | undefined {
  if (Array.isArray(answer)) return answer
  if (typeof answer === "string") return [answer]
  return undefined
}

/** Evaluates a structured question; the caller has already checked the question's base fields. */
function evaluateStructured(
  question: ClozeQuestion | OrderingQuestion | MatchingQuestion | CodeOutputQuestion,
  answer: AnswerInput | undefined
): AnswerEvaluation {
  const values = stringListAnswer(answer)
  if (values === undefined)
    return invalid(answer === undefined ? "missing-answer" : "wrong-answer-shape")
  if (question.type === "cloze") {
    const blanks = question.acceptedAnswers.map((accepted) =>
      accepted.map(normalizeBlankAnswer).filter(Boolean)
    )
    if (!blanks.length || blanks.some((accepted) => !accepted.length))
      return invalid("invalid-question")
    if (values.length !== blanks.length) return invalid("wrong-answer-shape")
    const typed = values.map(normalizeBlankAnswer)
    if (typed.every((value) => !value)) return invalid("missing-answer")
    const correct = typed.every((value, index) => blanks[index].includes(value))
    return { status: correct ? "correct" : "incorrect", isCorrect: correct, normalizedAnswer: typed }
  }
  if (question.type === "code-output") {
    const accepted = question.acceptedOutputs.map(normalizeOutputAnswer).filter(Boolean)
    if (!accepted.length) return invalid("invalid-question")
    if (values.length !== 1) return invalid("wrong-answer-shape")
    const typed = normalizeOutputAnswer(values[0])
    if (!typed) return invalid("missing-answer")
    const correct = accepted.includes(typed)
    return { status: correct ? "correct" : "incorrect", isCorrect: correct, normalizedAnswer: typed }
  }
  const optionIds = question.options.map((option) => option.id)
  if (new Set(optionIds).size !== optionIds.length) return invalid("invalid-question")
  if (question.type === "ordering") {
    const order = [...question.correctOrder]
    if (
      order.length < 2 ||
      order.length !== optionIds.length ||
      order.some((id) => !optionIds.includes(id)) ||
      new Set(order).size !== order.length
    )
      return invalid("invalid-question")
    if (!values.length) return invalid("missing-answer")
    if (values.length !== order.length) return invalid("incomplete-answer")
    if (new Set(values).size !== values.length) return invalid("duplicate-option")
    if (values.some((id) => !optionIds.includes(id))) return invalid("unknown-option")
    const correct = values.every((id, index) => id === order[index])
    return { status: correct ? "correct" : "incorrect", isCorrect: correct, normalizedAnswer: [...values] }
  }
  const expected = [...question.correctOptionIds]
  if (
    question.prompts.length < 2 ||
    expected.length !== question.prompts.length ||
    expected.some((id) => !optionIds.includes(id))
  )
    return invalid("invalid-question")
  if (!values.length || values.every((id) => !id)) return invalid("missing-answer")
  if (values.length !== expected.length || values.some((id) => !id))
    return invalid("incomplete-answer")
  if (values.some((id) => !optionIds.includes(id))) return invalid("unknown-option")
  const correct = values.every((id, index) => id === expected[index])
  return { status: correct ? "correct" : "incorrect", isCorrect: correct, normalizedAnswer: [...values] }
}

/** Produces an invalid answer result with a consistent shape. */
function invalid(reason: InvalidAnswerReason): AnswerEvaluation {
  return { status: "invalid", isCorrect: false, reason }
}

/** Gets a single option id from the supported option answer shapes. */
function singleAnswerId(answer: AnswerInput | undefined): string | undefined {
  if (typeof answer === "string") return answer
  if (answer && typeof answer === "object" && "optionId" in answer)
    return answer.optionId
  return undefined
}

/** Gets an option-id list from the supported multiple-answer shapes. */
function multipleAnswerIds(
  answer: AnswerInput | undefined
): readonly string[] | undefined {
  if (Array.isArray(answer)) return answer
  if (answer && typeof answer === "object" && "optionIds" in answer)
    return answer.optionIds
  return undefined
}

/** Evaluates one answer and never changes review state as a side effect. */
export function evaluateAnswer(
  question: Question,
  answer: AnswerInput | undefined
): AnswerEvaluation {
  if (
    !question.id.trim() ||
    !question.conceptId.trim() ||
    !question.prompt.trim()
  )
    return invalid("invalid-question")
  if (question.type === "single-choice") {
    const optionIds = question.options.map((option) => option.id)
    if (
      !question.options.length ||
      new Set(optionIds).size !== optionIds.length ||
      !optionIds.includes(question.correctOptionId)
    )
      return invalid("invalid-question")
    const selected = singleAnswerId(answer)
    if (selected === undefined || !selected.trim())
      return invalid("missing-answer")
    if (!optionIds.includes(selected)) return invalid("unknown-option")
    return {
      status: selected === question.correctOptionId ? "correct" : "incorrect",
      isCorrect: selected === question.correctOptionId,
      normalizedAnswer: selected,
    }
  }
  if (question.type === "multiple-answer") {
    const optionIds = question.options.map((option) => option.id)
    const correctIds = [...question.correctOptionIds]
    if (
      !question.options.length ||
      new Set(optionIds).size !== optionIds.length ||
      !correctIds.length ||
      new Set(correctIds).size !== correctIds.length ||
      correctIds.some((id) => !optionIds.includes(id))
    )
      return invalid("invalid-question")
    const selected = multipleAnswerIds(answer)
    if (selected === undefined || selected.length === 0)
      return invalid("missing-answer")
    if (new Set(selected).size !== selected.length)
      return invalid("duplicate-option")
    if (selected.some((id) => !optionIds.includes(id)))
      return invalid("unknown-option")
    const selectedSet = new Set(selected)
    const correct =
      selected.length === correctIds.length &&
      correctIds.every((id) => selectedSet.has(id))
    return {
      status: correct ? "correct" : "incorrect",
      isCorrect: correct,
      normalizedAnswer: [...selected].sort(),
    }
  }
  if (question.type === "true-false") {
    if (typeof answer !== "boolean")
      return invalid(
        answer === undefined ? "missing-answer" : "wrong-answer-shape"
      )
    return {
      status: answer === question.correctAnswer ? "correct" : "incorrect",
      isCorrect: answer === question.correctAnswer,
      normalizedAnswer: answer,
    }
  }
  if (
    question.type === "cloze" ||
    question.type === "ordering" ||
    question.type === "matching" ||
    question.type === "code-output"
  )
    return evaluateStructured(question, answer)
  if (question.type === "written") {
    if (!question.context || question.context !== "project-activity")
      return invalid("invalid-question")
    const accepted = question.acceptedAnswers
      .map(normalizeTextAnswer)
      .filter(Boolean)
    const normalized =
      typeof answer === "string" ? normalizeTextAnswer(answer) : ""
    if (!accepted.length) return invalid("invalid-question")
    if (!normalized) return invalid("missing-answer")
    return {
      status: accepted.includes(normalized) ? "correct" : "incorrect",
      isCorrect: accepted.includes(normalized),
      normalizedAnswer: normalized,
    }
  }
  return invalid("invalid-question")
}

/** Returns the candidate's deterministic sort key, preserving input order for ties. */
function itemSortKey(
  item: FeedItem,
  inputIndex: number
): [number, number, string] {
  return [item.order ?? item.createdAt, inputIndex, item.id]
}

/** Compares two feed entries by their stable producer order. */
function compareStable(
  a: { item: FeedItem; index: number },
  b: { item: FeedItem; index: number }
): number {
  const left = itemSortKey(a.item, a.index)
  const right = itemSortKey(b.item, b.index)
  const idOrder = left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0
  return left[0] - right[0] || left[1] - right[1] || idOrder
}

/** Orders due reviews by urgency, weakness, age, and then stable producer order. */
function compareDue(
  a: { item: ReviewFeedItem; index: number },
  b: { item: ReviewFeedItem; index: number },
  now: number
): number {
  const overdueA = now - a.item.reviewState.dueAt
  const overdueB = now - b.item.reviewState.dueAt
  return (
    overdueB - overdueA ||
    b.item.reviewState.incorrectCount - a.item.reviewState.incorrectCount ||
    (a.item.reviewState.lastAttemptAt ?? -Infinity) -
      (b.item.reviewState.lastAttemptAt ?? -Infinity) ||
    compareStable(a, b)
  )
}

/** Picks an entry while preferring concepts absent from the recent set. */
function takeWithConceptPreference(
  queue: Array<{ item: FeedItem; index: number }>,
  previousConceptId: string | undefined,
  recentConceptIds: ReadonlySet<string>,
  preferredFormat?: FeedItemFormat
): { item: FeedItem; index: number } | undefined {
  const available = preferredFormat
    ? queue.filter((entry) => entry.item.format === preferredFormat)
    : queue
  if (!available.length) return undefined
  const fresh = queue.findIndex(
    (entry) =>
      (!preferredFormat || entry.item.format === preferredFormat) &&
      entry.item.conceptId !== previousConceptId &&
      !recentConceptIds.has(entry.item.conceptId)
  )
  if (fresh >= 0) return queue.splice(fresh, 1)[0]
  const different = queue.findIndex(
    (entry) =>
      (!preferredFormat || entry.item.format === preferredFormat) &&
      entry.item.conceptId !== previousConceptId
  )
  if (different >= 0) return queue.splice(different, 1)[0]
  const sameFormat = queue.findIndex(
    (entry) => !preferredFormat || entry.item.format === preferredFormat
  )
  return sameFormat >= 0 ? queue.splice(sameFormat, 1)[0] : undefined
}

/** Selects a bounded mixed feed after applying project and topic filters. */
export function selectFeedItems(options: FeedSelectionOptions): FeedItem[] {
  if (!isTimestamp(options.now))
    throw new Error("Feed timestamp must be finite")
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) return []
  const allowedProjects = options.projectIds?.length
    ? new Set(options.projectIds)
    : options.projectId
      ? new Set([options.projectId])
      : undefined
  const allowedTopics = options.topicIds?.length
    ? new Set(options.topicIds)
    : options.topicId
      ? new Set([options.topicId])
      : undefined
  const filtered = options.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (allowedProjects && !allowedProjects.has(item.projectId)) return false
      if (allowedTopics && (!item.topicId || !allowedTopics.has(item.topicId)))
        return false
      if (item.kind === "review" && !isReviewDue(item.reviewState, options.now))
        return false
      return true
    })
  const seenIds = new Set<string>()
  const unique = filtered.filter(({ item }) => {
    if (seenIds.has(item.id)) return false
    seenIds.add(item.id)
    return true
  })
  const due: Array<{ item: FeedItem; index: number }> = unique
    .filter(
      (entry): entry is { item: ReviewFeedItem; index: number } =>
        entry.item.kind === "review"
    )
    .sort((a, b) => compareDue(a, b, options.now))
  const fresh: Array<{ item: FeedItem; index: number }> = unique
    .filter(
      (entry): entry is { item: NewFeedItem; index: number } =>
        entry.item.kind === "new"
    )
    .sort(compareStable)
  const recent = new Set(options.recentConceptIds ?? [])
  const result: FeedItem[] = []
  let previousConceptId = options.previousConceptId
  let preferDue = due.length > 0
  let consecutiveExplanations = 0
  while (result.length < options.limit && (due.length || fresh.length)) {
    const primary = preferDue ? due : fresh
    const secondary = preferDue ? fresh : due
    const questionAvailable =
      primary.some((entry) => entry.item.format === "question") ||
      secondary.some((entry) => entry.item.format === "question")
    const preferredFormat: FeedItemFormat | undefined =
      consecutiveExplanations >= 2 && questionAvailable ? "question" : undefined
    let picked = takeWithConceptPreference(
      primary,
      previousConceptId,
      recent,
      preferredFormat
    )
    if (picked && picked.item.conceptId === previousConceptId) {
      const alternate = takeWithConceptPreference(
        secondary,
        previousConceptId,
        recent,
        preferredFormat
      )
      if (alternate && alternate.item.conceptId !== previousConceptId) {
        primary.unshift(picked)
        picked = alternate
      } else if (alternate) {
        // The alternate was only inspected. Keep it available when it cannot
        // improve concept diversity, otherwise the batch would lose an item.
        secondary.unshift(alternate)
      }
    }
    if (!picked)
      picked = takeWithConceptPreference(
        secondary,
        previousConceptId,
        recent,
        preferredFormat
      )
    if (!picked && preferredFormat)
      picked = takeWithConceptPreference(secondary, previousConceptId, recent)
    if (!picked) break
    result.push(picked.item)
    previousConceptId = picked.item.conceptId
    recent.add(previousConceptId)
    consecutiveExplanations =
      picked.item.format === "explanation" ? consecutiveExplanations + 1 : 0
    preferDue = due.length > 0 && (fresh.length === 0 || !preferDue)
  }
  return result
}

/** Short alias for callers that describe feed selection as choosing a feed. */
export const selectFeed = selectFeedItems

/** Short alias for integrations that call the reducer an update operation. */
export const updateReviewState = applyReviewEvent
