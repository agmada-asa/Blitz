/** Tests deterministic source-part identity used by indexed retry deduplication. */

import assert from "node:assert/strict"
import test from "node:test"

import { sourceImportFingerprint } from "../lib/source-fingerprint.ts"

test("source fingerprints are stable and change with persisted source identity", () => {
  const input = {
    filename: "manual (Part 1 of 2).pdf",
    kind: "pdf",
    text: "[Part 1 of 2]\nA chapter.",
    originalUrl: "https://example.com/manual.pdf",
  }
  assert.equal(sourceImportFingerprint(input), sourceImportFingerprint(input))
  assert.notEqual(
    sourceImportFingerprint(input),
    sourceImportFingerprint({ ...input, text: `${input.text} changed` })
  )
  assert.notEqual(
    sourceImportFingerprint(input),
    sourceImportFingerprint({ ...input, filename: "manual (Part 2 of 2).pdf" })
  )
})
