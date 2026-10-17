/**
 * Remembers answers to quizzes in ordinary chat replies, in this browser's
 * local storage.
 *
 * Teach records each quiz answer on the server so it counts toward progress.
 * Chat quizzes are only a quick check, so they are graded in the browser and
 * cached here instead, which keeps a reload from resetting them to unanswered.
 * Answers are keyed by assistant message id, then quiz id, because quiz ids are
 * only unique within one reply. Only the most recently answered replies are
 * kept, so the cache stays small however long the learner uses chat.
 */

/** Local storage key for cached answers. Bump the suffix when the shape changes. */
export const CHAT_QUIZ_ANSWERS_KEY = "blitz_chat_quiz_answers_v1"

/** Replies whose answers are kept; older replies are dropped first. */
export const MAX_CACHED_QUIZ_REPLIES = 200

/** Upper bound on quizzes kept for one reply, well above what a reply contains. */
const MAX_QUIZZES_PER_REPLY = 20

/** Upper bound on values kept for one answer, covering every quiz format. */
const MAX_ANSWER_VALUES = 12

/** One recorded answer, in the shape the quiz block restores from. */
export type CachedQuizAnswer = {
  readonly selectedOptionIds: string[]
  readonly correct: boolean
}

/** Cached answers keyed by message id, then quiz id, oldest reply first. */
export type CachedQuizAnswers = Readonly<
  Record<string, Readonly<Record<string, CachedQuizAnswer>>>
>

/** Stable empty value used on the server and when nothing valid is cached. */
export const EMPTY_QUIZ_ANSWERS: CachedQuizAnswers = Object.freeze({})

/** Reads an object-like value without trusting its shape. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Rebuilds one answer, or returns undefined when it is malformed. */
function parseAnswer(value: unknown): CachedQuizAnswer | undefined {
  const answer = asObject(value)
  const selected = answer?.selectedOptionIds
  if (typeof answer?.correct !== "boolean" || !Array.isArray(selected))
    return undefined
  if (!selected.every((item): item is string => typeof item === "string"))
    return undefined
  return {
    selectedOptionIds: selected.slice(0, MAX_ANSWER_VALUES),
    correct: answer.correct,
  }
}

/**
 * Parses stored answers, discarding anything malformed.
 *
 * @param raw - The stored JSON string, or null when nothing is stored.
 * @returns Valid answers keyed by message and quiz id; empty when the value is
 *   missing or invalid.
 */
export function parseCachedQuizAnswers(raw: string | null): CachedQuizAnswers {
  if (!raw) return EMPTY_QUIZ_ANSWERS
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return EMPTY_QUIZ_ANSWERS
  }
  const replies = asObject(stored)
  if (!replies) return EMPTY_QUIZ_ANSWERS
  const result: Record<string, Record<string, CachedQuizAnswer>> = {}
  for (const [messageId, quizzes] of Object.entries(replies).slice(
    -MAX_CACHED_QUIZ_REPLIES
  )) {
    const entries = Object.entries(asObject(quizzes) ?? {})
      .slice(0, MAX_QUIZZES_PER_REPLY)
      .map(([quizId, answer]) => [quizId, parseAnswer(answer)] as const)
      .filter((entry): entry is [string, CachedQuizAnswer] => !!entry[1])
    if (entries.length) result[messageId] = Object.fromEntries(entries)
  }
  return result
}

/**
 * Adds or replaces one answer, moving its reply to the newest position and
 * dropping the oldest replies beyond {@link MAX_CACHED_QUIZ_REPLIES}.
 *
 * @param answers - Current cached answers.
 * @param messageId - Assistant message containing the quiz.
 * @param quizId - Quiz id within that message.
 * @param answer - The learner's latest answer; a retry replaces the earlier one.
 * @returns A new cache value; the input is not modified.
 */
export function withQuizAnswer(
  answers: CachedQuizAnswers,
  messageId: string,
  quizId: string,
  answer: CachedQuizAnswer
): CachedQuizAnswers {
  const { [messageId]: reply, ...others } = answers
  const next = { ...others, [messageId]: { ...reply, [quizId]: answer } }
  return Object.fromEntries(Object.entries(next).slice(-MAX_CACHED_QUIZ_REPLIES))
}

/** Parsed snapshot shared by every reply so renders read storage once. */
let snapshot: CachedQuizAnswers | undefined
/** Chats subscribed to answer updates in this tab. */
const listeners = new Set<() => void>()

/** Returns the cached answers for `useSyncExternalStore` in the browser. */
export function getCachedQuizAnswers(): CachedQuizAnswers {
  if (snapshot) return snapshot
  try {
    snapshot = parseCachedQuizAnswers(
      window.localStorage.getItem(CHAT_QUIZ_ANSWERS_KEY)
    )
  } catch {
    snapshot = EMPTY_QUIZ_ANSWERS
  }
  return snapshot
}

/** Returns the empty server snapshot so hydration matches the server render. */
export function getServerQuizAnswers(): CachedQuizAnswers {
  return EMPTY_QUIZ_ANSWERS
}

/**
 * Subscribes to answer updates from this tab and from other open Blitz tabs.
 *
 * @returns A function that removes the subscription.
 */
export function subscribeToQuizAnswers(listener: () => void): () => void {
  listeners.add(listener)
  /** Rereads the cache after another tab writes it. */
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== CHAT_QUIZ_ANSWERS_KEY) return
    snapshot = undefined
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * Caches one answer and notifies subscribed chats. When storage is full or
 * blocked, the answer still shows until the page reloads.
 */
export function saveQuizAnswer(
  messageId: string,
  quizId: string,
  answer: CachedQuizAnswer
): void {
  snapshot = withQuizAnswer(getCachedQuizAnswers(), messageId, quizId, answer)
  try {
    window.localStorage.setItem(CHAT_QUIZ_ANSWERS_KEY, JSON.stringify(snapshot))
  } catch {
    // Keep the in-memory snapshot so this page still shows the answer.
  }
  listeners.forEach((listener) => listener())
}
