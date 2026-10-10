/** Verifies drill ordering, concept strength, and question-bank prompting and validation. */

import assert from "node:assert/strict"
import test from "node:test"

import { conceptStrength, selectDrillQuestions, type DrillCandidate } from "../lib/drill.ts"
import { buildQuestionBankPrompt, parseQuestionBank } from "../lib/practice.ts"
import { relearnMessage } from "../lib/teach.ts"

const now = 1_000_000

/** Builds a drill candidate with sensible defaults. */
function candidate(itemId: string, overrides: Partial<DrillCandidate> = {}): DrillCandidate {
  return { itemId, conceptId: `c-${itemId}`, createdAt: 0, strength: "new", ...overrides }
}

test("classifies concept strength from answer history", () => {
  assert.equal(conceptStrength({ attempts: 0, correct: 0, consecutiveCorrect: 0 }), "new")
  assert.equal(
    conceptStrength({ attempts: 5, correct: 4, consecutiveCorrect: 0, lastOutcome: "incorrect" }),
    "weak"
  )
  assert.equal(conceptStrength({ attempts: 4, correct: 2, consecutiveCorrect: 1, lastOutcome: "correct" }), "weak")
  assert.equal(conceptStrength({ attempts: 1, correct: 1, consecutiveCorrect: 1, lastOutcome: "correct" }), "learning")
  assert.equal(conceptStrength({ attempts: 5, correct: 5, consecutiveCorrect: 3, lastOutcome: "correct" }), "strong")
  assert.equal(conceptStrength({ attempts: 10, correct: 7, consecutiveCorrect: 4, lastOutcome: "correct" }), "learning")
})

test("asks missed, then due, then new weak, then new, then the rest", () => {
  const order = selectDrillQuestions(
    [
      candidate("done", { lastOutcome: "correct", lastAnsweredAt: 10, conceptDueAt: now + 1, strength: "strong" }),
      candidate("new", { strength: "new" }),
      candidate("missed", { lastOutcome: "incorrect", lastAnsweredAt: 50, strength: "weak" }),
      candidate("due", { lastOutcome: "correct", lastAnsweredAt: 20, conceptDueAt: now - 1, strength: "learning" }),
      candidate("new-weak", { strength: "weak" }),
    ],
    now,
    5
  )
  assert.deepEqual(order, ["missed", "due", "new-weak", "new", "done"])
})

test("avoids asking the same concept twice in a row when it can", () => {
  const order = selectDrillQuestions(
    [
      candidate("a1", { conceptId: "a", createdAt: 1 }),
      candidate("a2", { conceptId: "a", createdAt: 2 }),
      candidate("b1", { conceptId: "b", createdAt: 3 }),
    ],
    now,
    3
  )
  assert.deepEqual(order, ["a1", "b1", "a2"])
})

test("respects the limit and handles empty input", () => {
  assert.deepEqual(selectDrillQuestions([], now, 5), [])
  assert.deepEqual(selectDrillQuestions([candidate("x")], now, 0), [])
  assert.equal(
    selectDrillQuestions(
      Array.from({ length: 20 }, (_, index) => candidate(`q${index}`)),
      now,
      10
    ).length,
    10
  )
})

test("the bank prompt carries material, weak concepts, and questions to avoid", () => {
  const prompt = buildQuestionBankPrompt({
    moduleTitle: "COMP26120",
    unitTitle: "Week 1",
    sources: [{ filename: "slides.pdf", text: "Karatsuba uses three multiplications." }],
    taughtSections: ["Divide and conquer"],
    weakConcepts: ["Total correctness"],
    existingQuestions: ["What is a loop invariant?"],
    existingConcepts: ["Loop invariants"],
    count: 99,
  })
  assert.match(prompt, /Write exactly 30 new questions/)
  assert.match(prompt, /Karatsuba uses three multiplications\./)
  assert.match(prompt, /Total correctness/)
  assert.match(prompt, /- What is a loop invariant\?/)
  assert.match(prompt, /Reuse these existing concept names exactly.*Loop invariants/)
})

test("parses a fenced reply, drops invalid and duplicate questions, and renumbers ids", () => {
  const reply = [
    "Here you go:",
    "```json",
    JSON.stringify({
      questions: [
        { id: "x", concept: "Recursion", type: "single-choice", question: "Base case?", options: ["Stops", "Loops"], answer: 0, explanation: "It stops." },
        { id: "x", concept: "Recursion", type: "single-choice", question: "base  case?", options: ["A", "B"], answer: 1, explanation: "Dup." },
        { concept: "Bad", type: "single-choice", question: "No answer", options: ["A", "B"], explanation: "Missing answer." },
        { concept: "Facts", type: "true-false", question: "2 + 2 = 4", answer: true, explanation: "Arithmetic." },
      ],
    }),
    "```",
  ].join("\n")
  const parsed = parseQuestionBank(reply)
  assert.equal(parsed.rejected, 2)
  assert.deepEqual(
    parsed.questions.map((question) => [question.id, question.type, question.correctOptionIds]),
    [
      ["b1", "single-choice", ["a"]],
      ["b4", "true-false", ["true"]],
    ]
  )
})

test("rejects replies without a questions list", () => {
  assert.throws(() => parseQuestionBank("No JSON here"), /no JSON object/)
  assert.throws(() => parseQuestionBank('{"items": []}'), /no questions list/)
})

test("relearn messages name the concept and the missed question", () => {
  const message = relearnMessage("Total correctness", "An algorithm is   totally correct when…")
  assert.match(message, /"Total correctness"/)
  assert.match(message, /"An algorithm is totally correct when…"/)
  assert.match(relearnMessage("Recursion"), /^I'm not getting "Recursion"\. Re-teach/)
})
