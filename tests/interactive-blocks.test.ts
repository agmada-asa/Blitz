/** Checks the interactive Markdown block protocol: parsing, normalization, discovery, and summaries. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { lexer, type Tokens } from "marked"
import {
  buildVizDocument,
  findQuizBlocks,
  gradeQuizAnswer,
  INTERACTIVE_BLOCK_LANGUAGES,
  INTERACTIVE_BLOCKS_PROMPT,
  interactiveBlockSpeechText,
  isClosedCodeFence,
  isInteractiveBlockLanguage,
  parseInteractiveBlock,
  VIZ_CONTENT_SECURITY_POLICY,
  type InteractiveBlock,
  type QuizBlock,
} from "../lib/interactive-blocks.ts"

/** Builds a valid single-choice quiz body, letting each test override one field. */
function quiz(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "q1",
    concept: "Karatsuba multiplication",
    type: "single-choice",
    question: "How many recursive multiplications does Karatsuba use?",
    options: ["2", "3", "4"],
    answer: 1,
    explanation: "Three products recover the middle term.",
    ...overrides,
  })
}

/** Parses a block that must be valid and returns it, failing with the parser error otherwise. */
function valid(info: string, source: string): InteractiveBlock {
  const parsed = parseInteractiveBlock(info, source)
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error)
  return parsed.block
}

/** Asserts that a block is rejected with an error message. */
function invalid(info: string, source: string): string {
  const parsed = parseInteractiveBlock(info, source)
  assert.equal(parsed.ok, false)
  return parsed.ok ? "" : parsed.error
}

test("recognizes only the four interactive languages", () => {
  assert.deepEqual(
    [...INTERACTIVE_BLOCK_LANGUAGES],
    ["quiz", "steps", "viz", "followups"]
  )
  for (const language of INTERACTIVE_BLOCK_LANGUAGES)
    assert.equal(isInteractiveBlockLanguage(language), true)
  assert.equal(isInteractiveBlockLanguage("mermaid"), false)
  assert.equal(isInteractiveBlockLanguage(""), false)
  assert.match(invalid("python", "print(1)"), /not an interactive block/)
})

test("normalizes single-choice options to letter ids and accepts a one-element answer array", () => {
  const block = valid("quiz", quiz({ options: ["  2 ", "3", "4"] }))
  assert.deepEqual(block, {
    kind: "quiz",
    id: "q1",
    concept: "Karatsuba multiplication",
    type: "single-choice",
    question: "How many recursive multiplications does Karatsuba use?",
    options: [
      { id: "a", text: "2" },
      { id: "b", text: "3" },
      { id: "c", text: "4" },
    ],
    correctOptionIds: ["b"],
    explanation: "Three products recover the middle term.",
  })
  const arrayAnswer = valid("quiz", quiz({ answer: [2] })) as QuizBlock
  assert.deepEqual(arrayAnswer.correctOptionIds, ["c"])
  // Language matching ignores case and a quiz ignores any trailing title.
  assert.equal(valid("Quiz extra words", quiz()).kind, "quiz")
})

test("normalizes true-false questions to fixed options and ignores supplied options", () => {
  const block = valid(
    "quiz",
    quiz({ type: "true-false", options: ["Yes", "No"], answer: false })
  ) as QuizBlock
  assert.deepEqual(block.options, [
    { id: "true", text: "True" },
    { id: "false", text: "False" },
  ])
  assert.deepEqual(block.correctOptionIds, ["false"])
  assert.match(
    invalid("quiz", quiz({ type: "true-false", answer: "true" })),
    /true or false/
  )
})

test("enforces multiple-answer rules", () => {
  const options = ["A", "B", "C", "D"]
  const block = valid(
    "quiz",
    quiz({ type: "multiple-answer", options, answer: [3, 0] })
  ) as QuizBlock
  assert.deepEqual(block.correctOptionIds, ["a", "d"])

  for (const answer of [[1], [0, 1, 2, 3], [0, 0], [0, 4], [0, 1.5], 1])
    invalid("quiz", quiz({ type: "multiple-answer", options, answer }))
})

test("rejects invalid quiz fields", () => {
  invalid("quiz", "{not json")
  invalid("quiz", "[]")
  invalid("quiz", quiz({ id: "has space" }))
  invalid("quiz", quiz({ id: "x".repeat(65) }))
  invalid("quiz", quiz({ id: undefined }))
  invalid("quiz", quiz({ concept: "   " }))
  invalid("quiz", quiz({ concept: "c".repeat(121) }))
  invalid("quiz", quiz({ question: "q".repeat(1001) }))
  invalid("quiz", quiz({ explanation: "" }))
  invalid("quiz", quiz({ explanation: "e".repeat(2001) }))
  invalid("quiz", quiz({ type: "essay" }))
  invalid("quiz", quiz({ options: ["only one"], answer: 0 }))
  invalid("quiz", quiz({ options: ["1", "2", "3", "4", "5", "6", "7"] }))
  invalid("quiz", quiz({ options: ["same", " same "] }))
  invalid("quiz", quiz({ options: ["ok", 2] }))
  invalid("quiz", quiz({ options: undefined }))
  invalid("quiz", quiz({ answer: 3 }))
  invalid("quiz", quiz({ answer: -1 }))
  invalid("quiz", quiz({ answer: [0, 1] }))
  assert.match(invalid("quiz", quiz({ answer: "1" })), /^Invalid quiz block:/)
})

test("parses steps with an info string title and optional step titles", () => {
  const block = valid(
    "steps   Solving   a linear equation ",
    JSON.stringify({
      steps: [
        { title: "Isolate", body: "Subtract 3: $2x = 8$." },
        { title: "  ", body: "Divide by 2." },
      ],
    })
  )
  assert.deepEqual(block, {
    kind: "steps",
    title: "Solving a linear equation",
    steps: [
      { title: "Isolate", body: "Subtract 3: $2x = 8$." },
      { body: "Divide by 2." },
    ],
  })
  assert.equal("title" in valid("steps", '{"steps":[{"body":"x"}]}'), false)
})

test("rejects invalid steps", () => {
  invalid("steps", '{"steps":[]}')
  invalid("steps", '[{"body":"x"}]')
  invalid("steps", '{"steps":[{"title":"No body"}]}')
  invalid("steps", JSON.stringify({ steps: [{ body: "b".repeat(4001) }] }))
  invalid(
    "steps",
    JSON.stringify({ steps: Array.from({ length: 13 }, () => ({ body: "x" })) })
  )
  invalid("steps", '{"steps":[{"body":"x","title":4}]}')
})

test("parses viz HTML with a title and enforces size limits", () => {
  assert.deepEqual(valid("viz Recursion tree", "\n<svg></svg>\n"), {
    kind: "viz",
    title: "Recursion tree",
    html: "<svg></svg>",
  })
  assert.deepEqual(valid("viz", "<canvas></canvas>"), {
    kind: "viz",
    html: "<canvas></canvas>",
  })
  invalid("viz", "   \n")
  invalid("viz", "x".repeat(60_001))
})

test("parses follow-ups and rejects invalid lists", () => {
  assert.deepEqual(valid("followups", '[" Why? ","Show another example"]'), {
    kind: "followups",
    items: ["Why?", "Show another example"],
  })
  invalid("followups", "[]")
  invalid("followups", '["1","2","3","4","5"]')
  invalid("followups", JSON.stringify(["x".repeat(121)]))
  invalid("followups", '[""]')
  invalid("followups", '{"items":["Why?"]}')
  invalid("followups", "[1]")
})

test("finds valid quizzes in order, skipping invalid blocks and duplicate ids", () => {
  const markdown = [
    "# Karatsuba",
    "",
    "Splitting each number in half gives four products.",
    "",
    "```quiz",
    quiz({ id: "split" }),
    "```",
    "",
    "```steps Worked example",
    '{"steps":[{"body":"Multiply 12 by 34."}]}',
    "```",
    "",
    "```quiz",
    quiz({ id: "broken", answer: 9 }),
    "```",
    "",
    "> ```quiz",
    `> ${quiz({ id: "quoted", type: "true-false", answer: true })}`,
    "> ```",
    "",
    "1. A list item",
    "",
    "   ```quiz",
    `   ${quiz({ id: "listed", question: "Listed?" })}`,
    "   ```",
    "",
    "```quiz",
    quiz({ id: "split", question: "Duplicate id" }),
    "```",
    "",
    "```followups",
    '["Why three products?"]',
    "```",
  ].join("\n")

  const found = findQuizBlocks(markdown)
  assert.deepEqual(
    found.map((block) => block.id),
    ["split", "quoted", "listed"]
  )
  assert.equal(
    found[0].question,
    "How many recursive multiplications does Karatsuba use?"
  )
  assert.deepEqual(findQuizBlocks("No questions here."), [])
})

test("grades exact selections only", () => {
  const single = valid("quiz", quiz()) as QuizBlock
  assert.equal(gradeQuizAnswer(single, ["b"]), true)
  assert.equal(gradeQuizAnswer(single, ["a"]), false)
  assert.equal(gradeQuizAnswer(single, []), false)

  const multiple = valid(
    "quiz",
    quiz({ type: "multiple-answer", options: ["A", "B", "C"], answer: [0, 2] })
  ) as QuizBlock
  assert.equal(gradeQuizAnswer(multiple, ["c", "a"]), true)
  assert.equal(gradeQuizAnswer(multiple, ["a", "a", "c"]), true)
  assert.equal(gradeQuizAnswer(multiple, ["a"]), false)
  assert.equal(gradeQuizAnswer(multiple, ["a", "b", "c"]), false)
})

test("speech text summarizes blocks without revealing quiz answers", () => {
  const choice = valid("quiz", quiz()) as QuizBlock
  const choiceSpeech = interactiveBlockSpeechText(choice)
  assert.equal(
    choiceSpeech,
    "Question: How many recursive multiplications does Karatsuba use? Options: A. 2; B. 3; C. 4."
  )
  assert.doesNotMatch(choiceSpeech, /products|correct|answer/i)

  const multiple = valid(
    "quiz",
    quiz({ type: "multiple-answer", options: ["A", "B", "C"], answer: [0, 1] })
  )
  assert.match(interactiveBlockSpeechText(multiple), /Choose all that apply/)

  const trueFalse = valid(
    "quiz",
    quiz({ type: "true-false", answer: true, explanation: "Secret reason." })
  )
  const trueFalseSpeech = interactiveBlockSpeechText(trueFalse)
  assert.match(trueFalseSpeech, /True or false\.$/)
  assert.doesNotMatch(trueFalseSpeech, /Secret reason/)

  assert.equal(
    interactiveBlockSpeechText(
      valid(
        "steps Long division",
        '{"steps":[{"title":"Divide","body":"7 into 22"},{"body":"Bring down"}]}'
      )
    ),
    "Long division\n\nStep 1: Divide.\n7 into 22\n\nStep 2.\nBring down"
  )
  assert.equal(
    interactiveBlockSpeechText(valid("viz Recursion tree", "<p></p>")),
    "[Interactive visualisation: Recursion tree]"
  )
  assert.equal(
    interactiveBlockSpeechText(valid("viz", "<p></p>")),
    "[Interactive visualisation]"
  )
  assert.equal(interactiveBlockSpeechText(valid("followups", '["Why?"]')), "")
})

test("detects closed fences so streaming renderers wait for complete blocks", () => {
  const raws = lexer(
    "```viz\n<p>done</p>\n```\n\n~~~~quiz\n{}\n~~~~\n\n```steps\n{"
  )
    .filter((token): token is Tokens.Code => token.type === "code")
    .map((token) => token.raw)
  assert.deepEqual(raws.map(isClosedCodeFence), [true, true, false])
  assert.equal(isClosedCodeFence("```quiz"), false)
  assert.equal(isClosedCodeFence("    indented code"), false)
  assert.equal(isClosedCodeFence("````quiz\n{}\n```"), false)
})

test("viz documents lock down network access and only expose sanitized theme values", () => {
  const document = buildVizDocument(
    '<meta http-equiv="refresh" content="0;url=https://example.com"><p>Hi</p>',
    {
      dark: true,
      background: "#101010",
      foreground: "</style><script>alert(1)</script>",
      muted: "#242424",
      mutedForeground: "#aaaaaa",
      border: "#303030",
      brand: "#ff8065",
      brandForeground: "#1b0d0a",
      fontFamily: '"Instrument Sans Variable", sans-serif',
    }
  )
  assert.ok(
    document.indexOf(VIZ_CONTENT_SECURITY_POLICY) <
      document.indexOf("<p>Hi</p>")
  )
  assert.match(document, /color-scheme: dark;/)
  assert.match(document, /--foreground: #111111;/)
  assert.match(document, /--font-sans: "Instrument Sans Variable", sans-serif;/)
  assert.doesNotMatch(document, /alert\(1\)/)
  assert.doesNotMatch(document, /refresh/)
})

test("the prompt documents every block type with an example", () => {
  for (const language of INTERACTIVE_BLOCK_LANGUAGES)
    assert.match(INTERACTIVE_BLOCKS_PROMPT, new RegExp("```" + language))
  assert.match(INTERACTIVE_BLOCKS_PROMPT, /raw code/)

  // Every example in the prompt must itself parse, or the model would learn a broken shape.
  const examples = lexer(INTERACTIVE_BLOCKS_PROMPT).filter(
    (token): token is Tokens.Code => token.type === "code"
  )
  assert.equal(examples.length, INTERACTIVE_BLOCK_LANGUAGES.length)
  for (const example of examples)
    assert.ok(parseInteractiveBlock(example.lang ?? "", example.text).ok)
})
