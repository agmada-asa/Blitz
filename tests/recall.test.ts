/** Verifies which Review questions are asked from memory first. */

import assert from "node:assert/strict"
import test from "node:test"

import { canRecallFromMemory, startsAsRecall } from "../lib/learning/recall.ts"

test("only single-choice questions that stand without options are recallable", () => {
  assert.equal(
    canRecallFromMemory({ type: "single-choice", question: "What is the worst-case time of binary search?" }),
    true
  )
  assert.equal(
    canRecallFromMemory({ type: "single-choice", question: "Which of the following is a stable sort?" }),
    false
  )
  assert.equal(
    canRecallFromMemory({ type: "single-choice", question: "Which statement about B+ trees is correct?" }),
    false
  )
  assert.equal(canRecallFromMemory({ type: "multiple-answer", question: "Name two joins." }), false)
  assert.equal(
    canRecallFromMemory({ type: "single-choice", question: "What does this print?\n```py\nprint(1)\n```" }),
    false
  )
})

test("recall mode is stable per question and covers roughly half", () => {
  const cards = Array.from({ length: 200 }, (_, index) => ({
    id: `item${index}`,
    type: "single-choice",
    question: "What is a trigger?",
  }))
  const recall = cards.filter((card) => startsAsRecall(card)).length
  assert.ok(recall > 60 && recall < 140)
  assert.equal(startsAsRecall(cards[3]), startsAsRecall({ ...cards[3] }))
})
