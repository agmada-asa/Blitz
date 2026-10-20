/** Pure helpers for deterministic review replay and offline event idempotency. */

import {
  applyReviewEvent,
  createReviewState,
  type AnswerInput,
  type ConceptReviewState,
} from "./core.ts"
import type { AnswerConfidence } from "./fsrs.ts"

/** A server-scored answer event in the order-independent replay log. */
export interface ScoredReviewEvent {
  /** Timestamp from the learner device. */
  readonly occurredAt: number
  /** Server receipt timestamp used to break device-time ties. */
  readonly receivedAt: number
  /** Stable event ID used as the final deterministic tie breaker. */
  readonly eventId: string
  /** Server-derived answer outcome. */
  readonly outcome: "correct" | "incorrect"
  /** Whether the learner marked a right answer as a guess. */
  readonly confidence?: AnswerConfidence
}

/**
 * Compares two answer values. Multiple-answer selections ignore order;
 * pass `ordered` for answers where position is the answer (ordering,
 * matching, and typed blanks).
 */
export function answersEquivalent(
  first: AnswerInput,
  second: AnswerInput,
  ordered = false
): boolean {
  if (typeof first !== typeof second) return false
  if (Array.isArray(first) && Array.isArray(second)) {
    if (first.length !== second.length) return false
    const left = ordered ? [...first] : [...first].sort()
    const right = ordered ? [...second] : [...second].sort()
    return left.every((value, index) => value === right[index])
  }
  return first === second
}

/** Replays scored events in chronological order into one review summary. */
export function replayReviewEvents(
  conceptId: string,
  events: readonly ScoredReviewEvent[],
  initialAt: number
): ConceptReviewState {
  const ordered = [...events].sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      left.receivedAt - right.receivedAt ||
      (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)
  )
  let state = createReviewState(conceptId, ordered[0]?.occurredAt ?? initialAt)
  for (const event of ordered) {
    state = applyReviewEvent(state, {
      type: "answer",
      outcome: event.outcome,
      occurredAt: event.occurredAt,
      ...(event.confidence ? { confidence: event.confidence } : {}),
    })
  }
  return state
}
