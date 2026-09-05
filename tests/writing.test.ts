/** Verifies the durable written-answer policy at its framework-independent boundary. */

import assert from "node:assert/strict"
import test from "node:test"
import { applyWrittenAnswer } from "../lib/learning/writing.ts"

test("drafts can be replaced while comparison freezes the submitted answer", () => {
  const initial = { revealed: false, reference: "source explanation" }
  const draft = applyWrittenAnswer(initial, " first attempt ", false)
  assert.deepEqual(draft, {
    answer: "first attempt",
    revealed: false,
    reference: "source explanation",
  })
  const compared = applyWrittenAnswer(draft, "final attempt", true)
  assert.equal(compared.answer, "final attempt")
  assert.equal(compared.revealed, true)
  assert.equal(compared.reference, "source explanation")
  assert.throws(
    () => applyWrittenAnswer(compared, "rewritten after reveal", false),
    /cannot be changed/
  )
})

test("answer policy rejects blank and oversized submissions", () => {
  const state = { revealed: false, reference: "reference" }
  assert.throws(() => applyWrittenAnswer(state, "   ", false), /required/)
  assert.throws(
    () => applyWrittenAnswer(state, "x".repeat(10_001), false),
    /too long/
  )
})
