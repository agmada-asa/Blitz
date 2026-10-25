/**
 * Verifies the JSON Schemas background generation sends to Codex and Claude
 * Code, and that the existing reply parsers still validate schema-shaped
 * replies: every field present, unused ones null, and the provider's parsed
 * object used only when the reply text holds no JSON.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  EXAM_GRADING_SCHEMA,
  examPaperSchema,
  parseExamGrading,
  parseExamPaper,
} from "../lib/exam.ts"
import {
  parseQuestionBank,
  QUESTION_BANK_SCHEMA,
  replyObject,
} from "../lib/practice.ts"

/** Keywords Codex's strict mode rejects, so no generation schema may use them. */
const STRICT_UNSUPPORTED = [
  "minLength",
  "maxLength",
  "$schema",
  "default",
  "oneOf",
  "allOf",
]

/**
 * Walks a schema and returns where it breaks Codex's strict-mode rules: an
 * object that leaves a property optional or allows extra ones, or a keyword
 * strict mode refuses.
 */
function strictProblems(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return []
  const node = schema as Record<string, unknown>
  const problems = STRICT_UNSUPPORTED.filter((key) => key in node).map(
    (key) => `${path}: ${key}`
  )
  if (node.type === "object") {
    const keys = Object.keys((node.properties as object) ?? {})
    const required = (node.required as string[]) ?? []
    if (
      keys.some((key) => !required.includes(key)) ||
      required.length !== keys.length
    )
      problems.push(`${path}: not every property is required`)
    if (node.additionalProperties !== false)
      problems.push(`${path}: allows extra properties`)
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties")
      for (const [name, child] of Object.entries(value as object))
        problems.push(...strictProblems(child, `${path}.${name}`))
    else if (key === "items")
      problems.push(...strictProblems(value, `${path}[]`))
    else if (key === "anyOf")
      (value as unknown[]).forEach((child, index) =>
        problems.push(...strictProblems(child, `${path}|${index}`))
      )
  }
  return problems
}

test("every generation schema follows Codex's strict-mode rules", () => {
  for (const [name, schema] of Object.entries({
    past: examPaperSchema("past"),
    mock: examPaperSchema("mock"),
    grading: EXAM_GRADING_SCHEMA,
    bank: QUESTION_BANK_SCHEMA,
  })) {
    assert.deepEqual(strictProblems(schema), [], name)
    assert.equal((schema as { type?: unknown }).type, "object", `${name} root`)
  }
})

test("a past paper reply with every unused field null parses like the free-text form", () => {
  const reply = {
    title: "COMP101 January 2025",
    durationMinutes: null,
    totalMarks: 10,
    questions: [
      {
        number: "1",
        marks: 1,
        type: "single-choice",
        prompt: "Which structure is LIFO?",
        options: ["Queue", "Stack", "Heap"],
        answer: 1,
        explanation:
          "A stack pops the newest item first; a queue serves the oldest.",
        modelAnswer: null,
        markScheme: null,
        answerSource: "inferred",
        concept: "Stacks",
        unit: null,
      },
      {
        number: "2",
        marks: 1,
        type: "true-false",
        prompt: "A queue is FIFO.",
        options: null,
        answer: true,
        explanation: "Items leave in the order they arrived.",
        modelAnswer: null,
        markScheme: null,
        answerSource: null,
        concept: "Queues",
        unit: "U1",
      },
      {
        number: "3",
        marks: 4,
        type: "written",
        prompt: "Explain amortised cost.",
        options: null,
        answer: null,
        explanation: null,
        modelAnswer: "Average cost per operation over a worst-case sequence.",
        markScheme: [{ point: "Averages over a sequence", marks: 4 }],
        answerSource: "inferred",
        concept: "Amortised analysis",
        unit: null,
      },
    ],
  }
  const parsed = parseExamPaper(
    { text: JSON.stringify(reply), output: reply },
    { kind: "past", unitKeys: ["U1"], hasSolutions: false }
  )
  assert.equal(parsed.rejected, 0)
  assert.equal(parsed.statedTotalMarks, 10)
  assert.equal(parsed.durationMinutes, undefined)
  assert.deepEqual(
    parsed.questions.map((question) => [question.type, question.unitKey]),
    [
      ["single-choice", undefined],
      ["true-false", "U1"],
      ["written", undefined],
    ]
  )
})

test("grading and question bank replies with null fields still validate", () => {
  const grades = parseExamGrading(
    {
      text: "",
      output: {
        grades: [
          {
            id: "q1",
            marks: 3,
            feedback: "Clear definition, but no example of a sequence.",
          },
        ],
      },
    },
    [{ id: "q1", marks: 4 }]
  )
  assert.deepEqual(grades.missing, [])
  assert.equal(grades.grades[0].marks, 3)

  const bank = parseQuestionBank({
    text: JSON.stringify({
      recaps: [
        {
          concept: "Stacks",
          title: "Stacks",
          body: "A stack adds and removes at the same end, so the newest item leaves first.",
        },
      ],
      questions: [
        {
          id: "b1",
          concept: "Stacks",
          type: "true-false",
          question: "A stack is LIFO.",
          options: null,
          answer: true,
          explanation: "The last item pushed is the first popped.",
          pairs: null,
          extras: null,
        },
        {
          id: "b2",
          concept: "Stacks",
          type: "matching",
          question: "Match each operation to its effect.",
          options: null,
          answer: null,
          explanation: null,
          pairs: [
            ["push", "adds to the top"],
            ["pop", "removes the top"],
            ["peek", "reads the top"],
          ],
          extras: null,
        },
      ],
    }),
  })
  assert.equal(bank.rejected, 0)
  assert.equal(bank.questions.length, 2)
  assert.equal(bank.recaps.length, 1)
})

test("reply text wins over the parsed output so LaTeX repairs still apply", () => {
  // A provider's own parse turns an unescaped \theta into a tab; the text keeps it repairable.
  const text = '{"note":"$\\theta$"}'
  const value = replyObject({ text, output: { note: "$\theta$" } }) as {
    note: string
  }
  assert.equal(value.note, "$\\theta$")
})

test("the parsed output is used when the text holds no JSON, and nothing usable still throws", () => {
  assert.deepEqual(replyObject({ text: "Done.", output: { grades: [] } }), {
    grades: [],
  })
  assert.throws(() => replyObject({ text: "Done." }))
  assert.throws(() =>
    replyObject({ text: "Done.", output: ["not", "an", "object"] })
  )
})
