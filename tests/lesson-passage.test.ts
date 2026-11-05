/**
 * Covers the text rules behind quoting a lesson into the side chat: which
 * sentence a position falls in, and how captured text is tidied and bounded.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_PASSAGE_CHARACTERS,
  normalizePassage,
  sentenceBoundsAt,
} from "../lib/lesson-passage.ts"

/** Reads the sentence around an offset. */
function sentenceAt(text: string, offset: number): string {
  const { start, end } = sentenceBoundsAt(text, offset)
  return text.slice(start, end)
}

const PARAGRAPH =
  "A default constructor takes no arguments. Copying uses T(const T&), e.g. when passing by value. Moving is cheaper."

test("finds the sentence around a position", () => {
  assert.equal(sentenceAt(PARAGRAPH, 0), "A default constructor takes no arguments.")
  assert.equal(
    sentenceAt(PARAGRAPH, PARAGRAPH.indexOf("passing")),
    "Copying uses T(const T&), e.g. when passing by value."
  )
  assert.equal(sentenceAt(PARAGRAPH, PARAGRAPH.indexOf("cheaper")), "Moving is cheaper.")
})

test("keeps a position at or past the end inside the last sentence", () => {
  assert.equal(sentenceAt(PARAGRAPH, PARAGRAPH.length), "Moving is cheaper.")
  assert.equal(sentenceAt(PARAGRAPH, PARAGRAPH.length + 50), "Moving is cheaper.")
  assert.equal(sentenceAt(PARAGRAPH, -3), "A default constructor takes no arguments.")
})

test("leaves whitespace out of a sentence and handles empty text", () => {
  assert.equal(sentenceAt("  Only this.\n", 4), "Only this.")
  assert.deepEqual(sentenceBoundsAt("", 0), { start: 0, end: 0 })
})

test("tidies captured text while keeping its line breaks", () => {
  assert.equal(
    normalizePassage("  Operation |   Purpose \n\n\n T() | Create \n"),
    "Operation | Purpose\nT() | Create"
  )
  assert.equal(normalizePassage(" \n \n"), "")
})

test("cuts a long passage to what a saved annotation accepts", () => {
  const passage = normalizePassage("word ".repeat(2_000))
  assert.ok(passage.length <= MAX_PASSAGE_CHARACTERS)
  assert.ok(passage.endsWith("…"))
})
