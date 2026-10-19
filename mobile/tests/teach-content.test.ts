/** Checks how a Teach reply is split into Markdown and interactive blocks on the phone. */

import assert from "node:assert/strict"
import test from "node:test"

import { teachParts } from "../lib/teach-content.ts"

const quiz = JSON.stringify({
  id: "q1",
  concept: "Loops",
  type: "single-choice",
  question: "How many times does it run?",
  options: ["Once", "Twice"],
  answer: 1,
  explanation: "It loops twice.",
})

test("markers are hidden and blocks are split out in reading order", () => {
  const content = [
    "```section\ns2\n```",
    "Loops repeat work.",
    "```quiz\n" + quiz + "\n```",
    "That is the idea.",
  ].join("\n\n")
  const parts = teachParts(content, false)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["markdown", "block", "markdown"]
  )
  assert.equal(parts[0].kind === "markdown" && parts[0].text, "Loops repeat work.")
  assert.equal(parts[1].kind === "block" && parts[1].block.kind, "quiz")
})

test("an unclosed block is a placeholder while streaming and plain text after", () => {
  const content = "Intro.\n\n```quiz\n{\"id\": \"q1\""
  assert.deepEqual(
    teachParts(content, true).map((part) => part.kind),
    ["markdown", "pending"]
  )
  assert.deepEqual(
    teachParts(content, false).map((part) => part.kind),
    ["markdown"]
  )
})

test("an invalid block stays visible as Markdown", () => {
  const parts = teachParts("```quiz\n{\"broken\": true}\n```", false)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].kind, "markdown")
})
