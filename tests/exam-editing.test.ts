/**
 * Verifies editing exam questions: the edit validator that applies the
 * extractor's rules to a learner's changes, and the helpers that carry saved
 * answers across an edit or deletion and mark earlier attempts again.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { validateQuestionEdit, type EditableExamQuestion } from "../lib/exam.ts"
import {
  answerKeyChanged,
  optionIdMap,
  remapAnswers,
  rescoreResults,
  type ScorableQuestion,
} from "../lib/exam-scoring.ts"

const choice: EditableExamQuestion = {
  type: "single-choice",
  options: [
    { id: "a", text: "O(n)" },
    { id: "b", text: "O(log n)" },
    { id: "c", text: "O(n log n)" },
  ],
  answerSource: "inferred",
}

/** A valid single-choice edit of `choice`, with overrides. */
function choiceEdit(overrides: Record<string, unknown> = {}) {
  return {
    number: "1",
    marks: 1,
    type: "single-choice",
    prompt: "What is the cost of binary search?",
    concept: "Binary search",
    options: [
      { text: "O(n)", previousId: "a" },
      { text: "O(log n)", previousId: "b" },
      { text: "O(n log n)", previousId: "c" },
    ],
    correctIndices: [1],
    explanation: "Each step halves the range.",
    ...overrides,
  }
}

test("a valid choice edit keeps option identity and the extractor's ids", () => {
  const result = validateQuestionEdit(choice, choiceEdit(), "past")
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.question.options, [
    { id: "a", text: "O(n)" },
    { id: "b", text: "O(log n)" },
    { id: "c", text: "O(n log n)" },
  ])
  assert.deepEqual(result.question.correctOptionIds, ["b"])
  assert.deepEqual(result.previousOptionIds, ["a", "b", "c"])
  assert.equal("answerSource" in result.question, false)
})

test("choice edits can switch to multiple-answer but not to another format", () => {
  const multiple = validateQuestionEdit(
    choice,
    choiceEdit({ type: "multiple-answer", correctIndices: [0, 2] }),
    "mock"
  )
  assert.equal(multiple.ok, true)
  if (multiple.ok) assert.deepEqual(multiple.question.correctOptionIds, ["a", "c"])
  const written = validateQuestionEdit(choice, choiceEdit({ type: "written" }), "mock")
  assert.deepEqual(written, { ok: false, error: "This question's format can't change." })
})

test("choice edits are checked with the quiz rules and explain what to fix", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ prompt: "  " }, /Write the question/],
    [{ number: "" }, /number/],
    [{ concept: "" }, /concept/],
    [{ marks: 0 }, /marks/],
    [{ marks: 1.25 }, /half marks/],
    [{ explanation: "" }, /Explain/],
    [{ correctIndices: [] }, /one correct option/],
    [{ correctIndices: [0, 1] }, /one correct option/],
    [{ correctIndices: [7] }, /Check this question/],
    [{ options: [{ text: "Only", previousId: "a" }] }, /2 to 6 options/],
    [{ options: [{ text: "Same", previousId: null }, { text: "Same", previousId: null }], correctIndices: [0] }, /different/],
    [{ options: [{ text: "x", previousId: "z" }, { text: "y", previousId: null }], correctIndices: [0] }, /changed while you were editing/],
    [{ options: [{ text: "x", previousId: "a" }, { text: "y", previousId: "a" }], correctIndices: [0] }, /changed while you were editing/],
    [{ type: "multiple-answer", correctIndices: [0, 1, 2] }, /at least one incorrect/],
  ]
  for (const [overrides, message] of cases) {
    const result = validateQuestionEdit(choice, choiceEdit(overrides), "past")
    assert.equal(result.ok, false, JSON.stringify(overrides))
    if (!result.ok) assert.match(result.error, message)
  }
})

test("an edit may not repeat another question's wording", () => {
  const result = validateQuestionEdit(choice, choiceEdit(), "past", [
    "what is the cost of   binary search?",
  ])
  assert.deepEqual(result, {
    ok: false,
    error: "Another question on this paper already has this wording.",
  })
})

test("true-false and written edits are validated", () => {
  const trueFalse = validateQuestionEdit(
    { type: "true-false" },
    { number: "2", marks: 1, type: "true-false", prompt: "Merge sort is stable.", concept: "Sorting", answer: true, explanation: "Equal keys keep their order." },
    "mock"
  )
  assert.equal(trueFalse.ok, true)
  if (trueFalse.ok) assert.deepEqual(trueFalse.question.correctOptionIds, ["true"])

  const written = {
    number: "3a",
    marks: 4,
    type: "written",
    prompt: "Explain amortised analysis.",
    concept: "Amortised analysis",
    modelAnswer: "Average cost over a sequence of operations.",
    markScheme: [
      { point: "Defines a sequence of operations", marks: 2 },
      { point: "Bounds the total cost", marks: 2 },
    ],
  }
  const ok = validateQuestionEdit({ type: "written" }, written, "past")
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.question.markScheme, written.markScheme)
  const missingPoint = validateQuestionEdit(
    { type: "written" },
    { ...written, markScheme: [{ point: "", marks: 2 }] },
    "past"
  )
  assert.equal(missingPoint.ok, false)
  const noScheme = validateQuestionEdit({ type: "written" }, { ...written, markScheme: [] }, "past")
  assert.deepEqual(noScheme, { ok: false, error: "Add at least one mark scheme point." })
  const noModel = validateQuestionEdit({ type: "written" }, { ...written, modelAnswer: " " }, "past")
  assert.deepEqual(noModel, { ok: false, error: "Write a model answer." })
})

test("option id maps follow options through additions, removals, and moves", () => {
  // Removed "a", kept "c" then "b", added a new option.
  const map = optionIdMap(["c", "b", null], ["a", "b", "c"], ["a", "b", "c"])
  assert.deepEqual(map && [...map], [
    ["c", "a"],
    ["b", "b"],
  ])
  assert.equal(optionIdMap(["a"], ["a", "b"], ["a", "b"]), null)
  assert.equal(optionIdMap(["a", "a"], ["a", "b"], ["a", "b"]), null)
  assert.equal(optionIdMap(["z", null], ["a", "b"], ["a", "b"]), null)
})

test("answers are carried across an edit and dropped with a deleted question", () => {
  const answers = [
    { questionId: "q1", selectedOptionIds: ["a", "c"] },
    { questionId: "q2", text: "An answer" },
  ]
  const map = new Map([["c", "a"]])
  assert.deepEqual(remapAnswers(answers, "q1", map), [
    { questionId: "q1", selectedOptionIds: ["a"] },
    { questionId: "q2", text: "An answer" },
  ])
  assert.deepEqual(remapAnswers(answers, "q2", null), [answers[0]])
})

test("earlier attempts are marked again: choice from the key, written marks kept and clamped", () => {
  const questions: ScorableQuestion[] = [
    { id: "q1", type: "single-choice", marks: 2, correctOptionIds: ["b"], options: [{ id: "a" }, { id: "b" }] },
    { id: "q3", type: "written", marks: 3 },
    { id: "q4", type: "written", marks: 5 },
  ]
  const answers = [
    { questionId: "q1", selectedOptionIds: ["b"] },
    { questionId: "q3", text: "Long answer" },
    { questionId: "q4", text: "Another" },
  ]
  const results = [
    { questionId: "q1", outcome: "incorrect" as const, awardedMarks: 0 },
    { questionId: "q2", outcome: "correct" as const, awardedMarks: 1 },
    { questionId: "q3", outcome: "marked" as const, awardedMarks: 5, feedback: "Good" },
    { questionId: "q4", outcome: "pending" as const },
  ]
  assert.deepEqual(rescoreResults(questions, answers, results), [
    { questionId: "q1", outcome: "correct", awardedMarks: 2 },
    { questionId: "q3", outcome: "marked", awardedMarks: 3, feedback: "Good" },
    { questionId: "q4", outcome: "pending" },
  ])
})

test("answer key changes are detected through the option map", () => {
  const before = { type: "single-choice" as const, correctOptionIds: ["c"] }
  assert.equal(answerKeyChanged(before, { type: "single-choice", correctOptionIds: ["a"] }, new Map([["c", "a"]])), false)
  assert.equal(answerKeyChanged(before, { type: "single-choice", correctOptionIds: ["b"] }, new Map([["c", "a"]])), true)
  assert.equal(answerKeyChanged(before, { type: "single-choice", correctOptionIds: ["c"] }, new Map()), true)
  assert.equal(answerKeyChanged(before, { type: "multiple-answer", correctOptionIds: ["c"] }), true)
  const written = { type: "written" as const, modelAnswer: "A", markScheme: [{ point: "P", marks: 1 }] }
  assert.equal(answerKeyChanged(written, { ...written, modelAnswer: " A " }), false)
  assert.equal(answerKeyChanged(written, { ...written, markScheme: [{ point: "P", marks: 2 }] }), true)
})
