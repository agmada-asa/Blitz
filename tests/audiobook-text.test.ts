/** Verifies page-aware narration input and predictable spoken abbreviations. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  splitAudiobookSource,
  spokenAudiobookText,
} from "../lib/audiobook-text.ts"

test("keeps page and slide boundaries without speaking their markers", () => {
  assert.deepEqual(
    splitAudiobookSource(
      "[Page 1]\nA complete sentence.\n\n[Page 2]\nAnother point.\n\n[Slide 3]\nA final idea."
    ),
    [
      { text: "A complete sentence.", startsNewSection: true },
      { text: "Another point.", startsNewSection: true },
      { text: "A final idea.", startsNewSection: true },
    ]
  )
})

test("splits a long page into bounded continuations without adding page breaks", () => {
  const source = `First idea. ${"Long explanation. ".repeat(28)}`
  const sections = splitAudiobookSource(`[Page 4]\n${source}`, 120)
  assert.ok(sections.length > 1)
  assert.ok(sections.every((section) => section.text.length <= 120))
  assert.equal(sections[0].startsNewSection, true)
  assert.ok(sections.slice(1).every((section) => !section.startsNewSection))
  assert.equal(
    sections
      .map((section) => section.text)
      .join(" ")
      .replace(/\s+/g, " "),
    source.trim().replace(/\s+/g, " ")
  )
})

test("writes common abbreviations in speakable form", () => {
  assert.equal(
    spokenAudiobookText("AI vs. ML vs LLMs. AI adoption rises."),
    "A I versus M L versus large language models. A I adoption rises."
  )
})
