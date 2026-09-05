/** Tests bounded, lossless source-part splitting for large browser imports. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_SPLITTABLE_SOURCE_LENGTH,
  sourcePartFilename,
  splitSourceText,
} from "../lib/source-splitting.ts"

test("splits large text into attributed bounded parts without losing content", () => {
  const input = Array.from(
    { length: 40 },
    (_, index) => `[Page ${index + 1}]\n${"A useful note 🙂. ".repeat(5)}`
  ).join("\n\n")
  const parts = splitSourceText(input, { maxPartLength: 180 })

  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.text.length <= 180))
  assert.deepEqual(parts, splitSourceText(input, { maxPartLength: 180 }))
  const reconstructed = parts
    .map((part) => part.text.slice(part.text.indexOf("\n") + 1))
    .join("")
  assert.equal(reconstructed, input)
  assert.ok(
    parts.every((part) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text))
  )
})

test("keeps the original extension in bounded part filenames", () => {
  assert.equal(
    sourcePartFilename("Atomic Habits.pdf", 2, 4),
    "Atomic Habits (Part 2 of 4).pdf"
  )
  assert.ok(sourcePartFilename("x".repeat(300) + ".md", 1, 3).length <= 255)
})

test("rejects text beyond the bounded split input limit", () => {
  assert.throws(
    () => splitSourceText("x".repeat(MAX_SPLITTABLE_SOURCE_LENGTH + 1)),
    /too large/i
  )
})
