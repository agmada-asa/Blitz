/** Focused tests for retry identity and deliberate-session result accounting. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  createAttemptId,
  getSessionProgress,
  makeAnswerSubmission,
  summarizeSessionResults,
  type SessionQuestion,
} from "../lib/learning/session-contracts.ts"

const question: SessionQuestion = {
  itemId: "item-1",
  conceptId: "concept-1",
  type: "single-choice",
  title: "A concept",
  prompt: "Which option?",
  options: [{ id: "a", text: "A" }],
}

test("attempt identity and timestamp stay stable for retry payloads", () => {
  const first = makeAnswerSubmission(
    "session-1",
    question,
    "a",
    1_700_000_000_000
  )
  const retry = makeAnswerSubmission(
    "session-1",
    question,
    "a",
    1_700_000_000_000
  )

  assert.equal(first.attemptId, retry.attemptId)
  assert.equal(first.attemptId, createAttemptId("session-1", "item-1", "a"))
  assert.notEqual(
    first.attemptId,
    createAttemptId("session-1", "item-1", "different")
  )
  assert.deepEqual(first, retry)
})

test("progress and summary keep unanswered questions separate from wrong answers", () => {
  const answers = { "item-1": "a" as const, "item-2": undefined }
  assert.deepEqual(
    getSessionProgress([question, { ...question, itemId: "item-2" }], answers),
    {
      total: 2,
      answered: 1,
      unanswered: 1,
    }
  )
  assert.deepEqual(
    summarizeSessionResults(
      2,
      [
        {
          attemptId: "attempt-1",
          itemId: "item-1",
          status: "incorrect",
          isCorrect: false,
        },
      ],
      1
    ),
    {
      total: 2,
      scored: 1,
      correct: 0,
      incorrect: 1,
      invalid: 0,
      unanswered: 1,
    }
  )
})
