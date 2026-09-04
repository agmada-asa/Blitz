/** Tests persistence rules that stay framework-independent at the data boundary. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  answersEquivalent,
  replayReviewEvents,
} from "../lib/learning/replay.ts"

const NOW = 1_800_000_000_000

test("idempotency treats reordered multiple-answer payloads as equivalent", () => {
  assert.equal(answersEquivalent(["b", "a"], ["a", "b"]), true)
  assert.equal(answersEquivalent(["a", "b"], ["a", "c"]), false)
  assert.equal(answersEquivalent(true, false), false)
})

test("review replay follows occurred time instead of receipt order", () => {
  const state = replayReviewEvents(
    "concept-1",
    [
      {
        occurredAt: NOW + 2,
        receivedAt: NOW + 2,
        eventId: "second",
        outcome: "incorrect",
      },
      {
        occurredAt: NOW,
        receivedAt: NOW + 3,
        eventId: "first",
        outcome: "correct",
      },
    ],
    NOW
  )
  assert.equal(state.attemptCount, 2)
  assert.equal(state.correctCount, 1)
  assert.equal(state.incorrectCount, 1)
  assert.equal(state.lastOutcome, "incorrect")
  assert.equal(state.lastAttemptAt, NOW + 2)
})
