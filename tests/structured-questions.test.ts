/**
 * Checks the structured quiz formats (cloze, ordering, matching, code output)
 * end to end at the pure layer: parsing model JSON, the stable shuffle, local
 * grading, the learning core's server scoring, and the answer helpers the
 * renderers use.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  clozeDisplayText,
  gradeQuizAnswer,
  initialStructuredAnswer,
  interactiveBlockSpeechText,
  parseInteractiveBlock,
  quizPayload,
  stableShuffle,
  structuredAnswerReady,
  structuredQuestion,
  type QuizBlock,
} from "../lib/interactive-blocks.ts"
import {
  countClozeBlanks,
  evaluateAnswer,
  normalizeBlankAnswer,
  normalizeOutputAnswer,
} from "../lib/learning/core.ts"
import { answersEquivalent } from "../lib/learning/replay.ts"
import { parseQuestionBank } from "../lib/practice.ts"

/** Parses a quiz body that must be valid. */
function quiz(body: Record<string, unknown>): QuizBlock {
  const parsed = parseInteractiveBlock(
    "quiz",
    JSON.stringify({ id: "s1", concept: "Heaps", explanation: "Because.", ...body })
  )
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error)
  assert.equal(parsed.block.kind, "quiz")
  return parsed.block as QuizBlock
}

/** Asserts a quiz body is rejected. */
function rejected(body: Record<string, unknown>): void {
  const parsed = parseInteractiveBlock(
    "quiz",
    JSON.stringify({ id: "s1", concept: "Heaps", explanation: "Because.", ...body })
  )
  assert.equal(parsed.ok, false)
}

test("parses cloze blanks with accepted answers and grades leniently", () => {
  const block = quiz({
    type: "cloze",
    question: "A binary heap with n nodes has height {{1}}; its root holds the {{2}} key.",
    answer: [["O(log n)", "log n"], "smallest"],
  })
  assert.deepEqual(block.acceptedAnswers, [["O(log n)", "log n"], ["smallest"]])
  assert.deepEqual(block.options, [])
  assert.equal(gradeQuizAnswer(block, ["o( log n ).", "`Smallest`"]), true)
  assert.equal(gradeQuizAnswer(block, ["log n", "largest"]), false)
  assert.equal(gradeQuizAnswer(block, ["", ""]), false)
  assert.equal(clozeDisplayText(block.question).includes("____(1)"), true)
  assert.equal(countClozeBlanks(block.question), 2)
})

test("a single-blank cloze accepts a flat list of alternatives", () => {
  const block = quiz({ type: "cloze", question: "Merge sort runs in {{1}} time.", answer: ["O(n log n)", "n log n"] })
  assert.deepEqual(block.acceptedAnswers, [["O(n log n)", "n log n"]])
  assert.equal(gradeQuizAnswer(block, ["n log n"]), true)
})

test("rejects cloze questions with missing, skipped, or unanswered blanks", () => {
  rejected({ type: "cloze", question: "No blanks here.", answer: ["x"] })
  rejected({ type: "cloze", question: "Gap {{1}} and {{3}}.", answer: [["a"], ["b"]] })
  rejected({ type: "cloze", question: "Two {{1}} and {{2}}.", answer: [["a"]] })
  rejected({ type: "cloze", question: "One {{1}}.", answer: [[]] })
})

test("ordering shuffles deterministically, never into the answer order", () => {
  const steps = ["Read the input", "Build the heap", "Extract the minimum", "Print the result"]
  const first = quiz({ type: "ordering", question: "Order the steps, first to last.", options: steps })
  const second = quiz({ type: "ordering", question: "Order the steps, first to last.", options: steps })
  assert.deepEqual(first.options, second.options)
  // Ids follow the displayed order, so they reveal nothing about the answer.
  assert.deepEqual(first.options.map((option) => option.id), ["a", "b", "c", "d"])
  const textOf = (id: string) => first.options.find((option) => option.id === id)?.text
  assert.deepEqual(first.correctOptionIds.map(textOf), steps)
  assert.notDeepEqual(first.correctOptionIds, ["a", "b", "c", "d"])
  const answer = [...first.correctOptionIds]
  assert.equal(gradeQuizAnswer(first, answer), true)
  assert.equal(gradeQuizAnswer(first, [answer[1], answer[0], answer[2], answer[3]]), false)
  // The starting answer is the displayed order, which is always wrong.
  assert.equal(gradeQuizAnswer(first, initialStructuredAnswer(first)), false)
  rejected({ type: "ordering", question: "Too short", options: ["a", "b"] })
  rejected({ type: "ordering", question: "Duplicates", options: ["a", "a", "b"] })
})

test("stableShuffle permutes without losing items and rotates identity results", () => {
  for (const seed of ["a", "b", "c", "d", "e", "f"]) {
    const shuffled = stableShuffle([1, 2], seed)
    assert.deepEqual(shuffled, [2, 1])
  }
  const items = [1, 2, 3, 4, 5, 6, 7, 8]
  const shuffled = stableShuffle(items, "seed")
  assert.deepEqual([...shuffled].sort(), items)
})

test("matching pairs each prompt with one option, with optional extras", () => {
  const block = quiz({
    type: "matching",
    question: "Match each structure to its lookup cost.",
    pairs: [
      ["Hash table", "O(1) average"],
      ["Balanced BST", "O(log n)"],
      ["Linked list", "O(n)"],
    ],
    extras: ["O(n²)"],
  })
  assert.deepEqual(block.prompts, ["Hash table", "Balanced BST", "Linked list"])
  assert.equal(block.options.length, 4)
  assert.deepEqual(block.options.map((option) => option.id), ["a", "b", "c", "d"])
  const textOf = (id: string) => block.options.find((option) => option.id === id)?.text
  assert.deepEqual(block.correctOptionIds.map(textOf), ["O(1) average", "O(log n)", "O(n)"])
  const [first, second, third] = block.correctOptionIds
  assert.equal(gradeQuizAnswer(block, [first, second, third]), true)
  assert.equal(gradeQuizAnswer(block, [first, third, second]), false)
  assert.equal(gradeQuizAnswer(block, [first, second, ""]), false)
  assert.equal(structuredAnswerReady("matching", ["a", "b", ""]), false)
  assert.equal(structuredAnswerReady("matching", ["a", "b", "d"]), true)
  rejected({ type: "matching", question: "Too few", pairs: [["a", "1"], ["b", "2"]] })
  rejected({ type: "matching", question: "Repeat", pairs: [["a", "1"], ["b", "1"], ["c", "2"]] })
  rejected({ type: "matching", question: "Many extras", pairs: [["a", "1"], ["b", "2"], ["c", "3"]], extras: ["4", "5", "6"] })
})

test("code output requires code and compares output by line", () => {
  const block = quiz({
    type: "code-output",
    question: "What does this print?\n```python\nfor i in range(3):\n    print(i, i * i)\n```",
    answer: "0 0\n1 1\n2 4",
  })
  assert.equal(gradeQuizAnswer(block, ["0 0\r\n1  1 \n2 4\n"]), true)
  assert.equal(gradeQuizAnswer(block, ["0 0 1 1 2 4"]), false)
  assert.equal(normalizeOutputAnswer("  True\n\n"), "True")
  assert.notEqual(normalizeOutputAnswer("True"), normalizeOutputAnswer("true"))
  rejected({ type: "code-output", question: "What does print(1) print?", answer: "1" })
})

test("the learning core scores structured answers and rejects malformed ones", () => {
  const orderingQuiz = quiz({ type: "ordering", question: "Order these.", options: ["x", "y", "z"] })
  const ordering = structuredQuestion(orderingQuiz)
  assert.equal(evaluateAnswer(ordering, [...orderingQuiz.correctOptionIds]).status, "correct")
  assert.equal(evaluateAnswer(ordering, ["a", "b"]).reason, "incomplete-answer")
  assert.equal(evaluateAnswer(ordering, ["a", "a", "b"]).reason, "duplicate-option")
  assert.equal(evaluateAnswer(ordering, ["a", "b", "q"]).reason, "unknown-option")
  assert.equal(evaluateAnswer(ordering, true).reason, "wrong-answer-shape")
  const cloze = structuredQuestion(
    quiz({ type: "cloze", question: "{{1}} and {{2}}", answer: [["a"], ["b"]] })
  )
  assert.equal(evaluateAnswer(cloze, ["a"]).reason, "wrong-answer-shape")
  assert.equal(evaluateAnswer(cloze, ["", " "]).reason, "missing-answer")
  assert.equal(evaluateAnswer(cloze, ["A", "b"]).status, "correct")
  const output = structuredQuestion(
    quiz({ type: "code-output", question: "```c\nputs(\"hi\");\n```", answer: ["hi"] })
  )
  assert.equal(evaluateAnswer(output, "hi").status, "correct")
  assert.equal(evaluateAnswer(output, ["hi", "there"]).reason, "wrong-answer-shape")
})

test("ordered answers are not equivalent when reordered", () => {
  assert.equal(answersEquivalent(["a", "b"], ["b", "a"]), true)
  assert.equal(answersEquivalent(["a", "b"], ["b", "a"], true), false)
  assert.equal(answersEquivalent(["a", "b"], ["a", "b"], true), true)
})

test("blank normalization ignores case, spacing, quotes, and a trailing full stop", () => {
  assert.equal(normalizeBlankAnswer(" `Heap.` "), "heap")
  assert.equal(normalizeBlankAnswer("O( n )"), normalizeBlankAnswer("o(n)"))
  assert.equal(normalizeBlankAnswer('"O(n)".'), normalizeBlankAnswer("O(n)"))
})

test("speech text and payloads never include the answer key", () => {
  const block = quiz({ type: "cloze", question: "Root holds the {{1}} key.", answer: ["smallest"] })
  const speech = interactiveBlockSpeechText(block)
  assert.match(speech, /blank 1/)
  assert.equal(speech.includes("smallest"), false)
  const payload = quizPayload(block)
  assert.deepEqual(payload.acceptedAnswers, [["smallest"]])
  assert.equal("kind" in payload, false)
})

test("question banks keep valid structured questions and drop broken ones", () => {
  const parsed = parseQuestionBank(
    JSON.stringify({
      questions: [
        { concept: "Heaps", type: "cloze", question: "Height is {{1}}.", answer: [["log n"]], explanation: "Halving." },
        { concept: "Heaps", type: "ordering", question: "Order.", options: ["a", "b", "c"], explanation: "Steps." },
        { concept: "Heaps", type: "matching", question: "Match.", pairs: [["a", "1"]], explanation: "Too few." },
      ],
    })
  )
  assert.deepEqual(
    parsed.questions.map((question) => question.type),
    ["cloze", "ordering"]
  )
  assert.equal(parsed.rejected, 1)
})
