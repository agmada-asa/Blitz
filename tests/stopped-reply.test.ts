/**
 * Covers what a continued turn asks for: a stopped reply with text continues
 * where it stopped, and one that stopped before any text sends its request again.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { stoppedRequestToResend } from "../lib/stopped-reply.ts"

test("a reply that stopped before any text resends its request", () => {
  assert.equal(
    stoppedRequestToResend([
      { role: "assistant", content: "" },
      { role: "user", content: "Next section" },
      { role: "assistant", content: "Recap and final quiz" },
    ]),
    "Next section"
  )
  assert.equal(
    stoppedRequestToResend([
      { role: "assistant", content: "  \n" },
      { role: "user", content: "What is mutation testing?" },
    ]),
    "What is mutation testing?"
  )
})

test("a reply with text continues instead of resending", () => {
  assert.equal(
    stoppedRequestToResend([
      { role: "assistant", content: "Code review is" },
      { role: "user", content: "Next section" },
    ]),
    undefined
  )
})

test("nothing is resent without a user request with text before the reply", () => {
  assert.equal(stoppedRequestToResend([]), undefined)
  assert.equal(stoppedRequestToResend([{ role: "assistant", content: "" }]), undefined)
  assert.equal(
    stoppedRequestToResend([
      { role: "assistant", content: "" },
      { role: "user", content: "" },
    ]),
    undefined
  )
  assert.equal(
    stoppedRequestToResend([
      { role: "assistant", content: "" },
      { role: "assistant", content: "Earlier reply" },
    ]),
    undefined
  )
})
