/** Verifies page-aware audiobook input before model and speech preparation. */

import assert from "node:assert/strict"
import test from "node:test"

import { splitAudiobookSource } from "../lib/audiobook-text.ts"

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
