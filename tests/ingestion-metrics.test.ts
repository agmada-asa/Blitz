/** Tests the page density and section quality measures used by the ingestion eval. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  LOW_TEXT_PAGE_CHARACTERS,
  measurePageDensity,
  measureSectionQuality,
} from "../lib/evals/ingestion-metrics.ts"

test("page density counts page markers and flags pages with little text", () => {
  const dense = "Word ".repeat(100).trim()
  const text = `[Page 1]\n${dense}\n\n[Page 2]\nFigure 3\n\n[Page 3]\n${dense}`
  const density = measurePageDensity(text)
  assert.equal(density.pageCount, 3)
  assert.equal(density.lowTextPageCount, 1)
  assert.equal(density.medianCharactersPerPage, dense.length)
  assert.ok("Figure 3".length < LOW_TEXT_PAGE_CHARACTERS)
})

test("page density reports zero pages for text without page markers", () => {
  assert.deepEqual(measurePageDensity("A transcript without markers."), {
    pageCount: 0,
    lowTextPageCount: 0,
    medianCharactersPerPage: 0,
  })
})

test("section quality measures overlap, sentence cuts and titles", () => {
  const text = "First sentence. Second half of an idea continues here."
  const sections = [
    { text: text.slice(0, 16), startOffset: 0, endOffset: 16, title: "Intro" },
    // Overlaps the first section by 4 characters and ends mid-sentence.
    { text: text.slice(12, 30), startOffset: 12, endOffset: 30 },
    { text: text.slice(30), startOffset: 30, endOffset: text.length },
  ]
  const quality = measureSectionQuality(text, sections)
  assert.equal(quality.sectionCount, 3)
  assert.equal(quality.duplicatedCharacters, 4)
  assert.equal(quality.duplicatedShare, Math.round((4 / text.length) * 1000) / 1000)
  // The first interior end follows a full stop; the second cuts a sentence.
  assert.equal(quality.midSentenceEndShare, 0.5)
  assert.equal(quality.titledShare, Math.round((1 / 3) * 1000) / 1000)
  assert.equal(quality.largestSection, text.length - 30)
})

test("section quality treats a paragraph break as a clean boundary", () => {
  const text = "A heading line\n\nBody text"
  const quality = measureSectionQuality(text, [
    { text: "A heading line", startOffset: 0, endOffset: 14 },
    { text: "\n\nBody text", startOffset: 14, endOffset: text.length },
  ])
  assert.equal(quality.midSentenceEndShare, 0)
})

test("section quality returns zeros for a document without sections", () => {
  const quality = measureSectionQuality("", [])
  assert.equal(quality.sectionCount, 0)
  assert.equal(quality.largestSection, 0)
  assert.deepEqual(quality.sizePercentiles, { p10: 0, p50: 0, p90: 0 })
})
