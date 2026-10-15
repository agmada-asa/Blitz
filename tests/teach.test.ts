/** Verifies the Teach protocol: outline and section parsing, unit titles, prompts, and citation focus. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTeachPrompt,
  parseTeachOutline,
  parseTeachSectionMarker,
  stripTeachMarkers,
  suggestUnitTitle,
  TEACH_QUICK_REPLIES,
  TEACH_SOURCE_BUDGET,
  teachJumpMessage,
  teachUnitTitle,
} from "../lib/teach.ts"
import { teachTurnFocus } from "../lib/teach-focus.ts"

/** A realistic first reply with an outline, a section marker, and a quiz. */
const firstReply = [
  "```outline",
  JSON.stringify({
    title: "Integer multiplication",
    sections: [
      { id: "s1", title: "Grade-school multiplication" },
      { id: "s2", title: "Karatsuba's trick" },
      { id: "s2", title: "Duplicate id is dropped" },
      { id: "bad id!", title: "Invalid id is dropped" },
      { id: "s3", title: "Recurrences and complexity" },
    ],
  }),
  "```",
  "",
  "```section",
  "s1",
  "```",
  "",
  "Multiplying two n-digit numbers the school way takes about $n^2$ steps.",
  "",
  "```quiz",
  '{"id":"q1","concept":"Schoolbook multiplication","type":"true-false","question":"It is O(n^2).","answer":true,"explanation":"Each digit pairs with each digit."}',
  "```",
].join("\n")

test("reads the outline and drops duplicate or invalid sections", () => {
  assert.deepEqual(parseTeachOutline(firstReply), {
    title: "Integer multiplication",
    sections: [
      { id: "s1", title: "Grade-school multiplication" },
      { id: "s2", title: "Karatsuba's trick" },
      { id: "s3", title: "Recurrences and complexity" },
    ],
  })
})

test("ignores missing, unfinished, and malformed outlines", () => {
  assert.equal(parseTeachOutline("No outline here."), undefined)
  assert.equal(parseTeachOutline('```outline\n{"title":"Half'), undefined)
  assert.equal(parseTeachOutline('```outline\n{"title":"","sections":[]}\n```'), undefined)
})

test("reads section and done markers", () => {
  assert.deepEqual(parseTeachSectionMarker(firstReply), { kind: "section", id: "s1" })
  assert.deepEqual(parseTeachSectionMarker("```section\ndone\n```\nRecap"), { kind: "done" })
  assert.equal(parseTeachSectionMarker("Just answering a question."), undefined)
})

test("strips outline and section fences but keeps other blocks", () => {
  const stripped = stripTeachMarkers(firstReply)
  assert.ok(stripped.startsWith("Multiplying two n-digit numbers"))
  assert.ok(!stripped.includes("```outline"))
  assert.ok(!stripped.includes("```section"))
  assert.ok(stripped.includes("```quiz"))
})

test("suggests unit titles from week labels, shared words, or a single file", () => {
  assert.equal(
    suggestUnitTitle(
      [
        "Week 1-01 Overview-transcript.txt",
        "Week 1-01 Integer Multiplication Algorithms-transcript.txt",
        "w101-integer_multiplication.pdf",
        "fl-complexity-101.pdf",
      ],
      1
    ),
    "Week 1"
  )
  assert.equal(
    suggestUnitTitle(["CS201 Learning Video 6 RISC-V Design.pdf"], 3),
    "CS201 Learning Video 6 RISC V Design"
  )
  assert.equal(
    suggestUnitTitle(["Lecture 4 slides.pdf", "lecture-4-transcript.vtt"], 2),
    "Lecture 4"
  )
  assert.equal(
    suggestUnitTitle(["Normalisation notes.pdf", "Normalisation transcript.txt"], 2),
    "Normalisation"
  )
  assert.equal(suggestUnitTitle(["a.pdf", "b.pdf"], 5), "Unit 5")
  assert.equal(suggestUnitTitle([], 2), "Unit 2")
})

test("keeps a week label when the tutor names the topic", () => {
  assert.equal(teachUnitTitle("Week 1", "Integer multiplication"), "Week 1: Integer multiplication")
  assert.equal(teachUnitTitle("Normalisation", "Normal forms"), "Normal forms")
  assert.equal(teachUnitTitle("Week 2", "Week 2 recap"), "Week 2 recap")
})

test("first-turn prompts carry the protocol, material, and learner message", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "Algorithms",
    unitTitle: "Week 1",
    sources: [
      { filename: "overview.txt", text: "Triangular numbers.", relativeKey: "Sources/overview.txt" },
    ],
    message: TEACH_QUICK_REPLIES.start,
    includeContext: true,
  })
  assert.match(prompt, /```outline/)
  assert.match(prompt, /```quiz/)
  assert.match(prompt, /SOURCE: overview\.txt \(original file: Sources\/overview\.txt\)/)
  assert.match(prompt, /Triangular numbers\./)
  assert.match(prompt, /LEARNER MESSAGE BEGIN\n\nTeach me this unit\.\n\nLEARNER MESSAGE END$/)
})

test("later turns send only the learner message", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "M",
    unitTitle: "U",
    sources: [{ filename: "a.txt", text: "secret source text" }],
    message: TEACH_QUICK_REPLIES.next,
    includeContext: false,
  })
  assert.ok(!prompt.includes("secret source text"))
  assert.match(prompt, /Next section/)
})

test("rebuilt sessions restate the agreed outline and progress", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "M",
    unitTitle: "U",
    sources: [],
    message: "Next section",
    includeContext: true,
    outline: { title: "T", sections: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }] },
    sectionIndex: 0,
    history: [{ role: "assistant", content: "Earlier lesson" }],
  })
  assert.match(prompt, /Sections taught so far: 1 of 2\./)
  assert.match(prompt, /Earlier lesson/)
  assert.match(prompt, /No readable source text/)
})

test("splits the source budget so every file is represented", () => {
  const big = "x".repeat(TEACH_SOURCE_BUDGET)
  const prompt = buildTeachPrompt({
    moduleTitle: "M",
    unitTitle: "U",
    sources: [
      { filename: "big.pdf", text: big },
      { filename: "small.txt", text: "small file kept whole" },
    ],
    message: "",
    includeContext: true,
  })
  assert.match(prompt, /small file kept whole/)
  assert.match(prompt, /SOURCE: big\.pdf \[TRUNCATED/)
  assert.ok(prompt.length < TEACH_SOURCE_BUDGET + 20_000)
})

test("jump messages name the section", () => {
  assert.equal(teachJumpMessage(2, { id: "s3", title: "Recurrences" }), "Teach section 3: Recurrences")
})

test("citation focus follows the section the turn will teach", () => {
  const outline = {
    title: "Multiplication",
    sections: [
      { id: "s1", title: "Schoolbook" },
      { id: "s2", title: "Karatsuba" },
    ],
  }
  assert.equal(teachTurnFocus("Teach me this unit.", undefined, undefined), undefined)
  assert.equal(teachTurnFocus("Next section", outline, 0), "Karatsuba")
  assert.equal(teachTurnFocus("Next section", outline, 1), "Multiplication")
  assert.equal(teachTurnFocus("Teach section 2: Karatsuba", outline, 0), "Karatsuba")
  assert.equal(teachTurnFocus("Why three products?", outline, 1), "Why three products? Karatsuba")
})
