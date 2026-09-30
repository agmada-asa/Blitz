/** Verifies quick speech openings preserve words and Unicode across bounded sections. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  splitSpeechText,
  SPEECH_OPENING_CHARS,
  SPEECH_SECTION_CHARS,
} from "../lib/speech-text.ts"

test("uses a small opening and keeps the rest in playback order", () => {
  const text =
    "Read this first. " + "A study card asks one clear question. ".repeat(40)
  const chunks = splitSpeechText(text)
  assert.ok(chunks[0].length <= SPEECH_OPENING_CHARS)
  assert.ok(
    chunks.slice(1).every((chunk) => chunk.length <= SPEECH_SECTION_CHARS)
  )
  assert.equal(chunks.join(" "), text.trim())
  assert.match(chunks[0], /\.$/)
})

test("keeps a short item intact and skips empty content", () => {
  assert.deepEqual(splitSpeechText(" Read this. "), ["Read this."])
  assert.deepEqual(splitSpeechText(" \n "), [])
})

test("does not break surrogate pairs even inside a word longer than a section", () => {
  const text = "x".repeat(119) + "🙂" + "x".repeat(719)
  const chunks = splitSpeechText(text)
  assert.equal(chunks.join(""), text)
  assert.ok(chunks.every((chunk) => chunk.isWellFormed()))
})
