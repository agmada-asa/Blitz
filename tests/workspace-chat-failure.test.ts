/** Verifies actionable capacity and limit recovery and private-detail handling for workspace chat failures. */

import assert from "node:assert/strict"
import { test } from "node:test"
import { CardChatError } from "../lib/server/card-chat.ts"
import { SavedModelSettingsError } from "../lib/server/ai-model-settings.ts"
import { workspaceChatFailure } from "../lib/server/workspace-chat-failure.ts"

for (const failure of [
  {
    reason: "provider-overloaded",
    message:
      "The selected model is at capacity. Try again shortly or choose another model in Settings.",
  },
  {
    reason: "usage-limit",
    message:
      "You've reached the selected provider's usage limit. Wait for it to reset or choose another provider in Settings.",
  },
  {
    reason: "rate-limit",
    message:
      "Too many requests to the selected provider. Wait a moment, then try again.",
  },
] as const) {
  test(`${failure.reason} preserves recovery instructions and confirms saved context only when available`, () => {
    const error = new CardChatError(failure.reason, failure.message)
    assert.deepEqual(workspaceChatFailure(error, true), {
      reason: failure.reason,
      message: `${failure.message} Your chat context is saved.`,
    })
    assert.equal(workspaceChatFailure(error, false).message, failure.message)
  })
}

test("unknown failures keep provider messages and source content out of recovery copy", () => {
  const error = new CardChatError("turn-failed", "Private source content", {
    message: "Private provider details",
  })
  assert.deepEqual(workspaceChatFailure(error, true), {
    reason: "turn-failed",
    message:
      "Blitz could not finish that reply. Your chat context is saved, so try again.",
  })
  assert.deepEqual(workspaceChatFailure(new Error("Private details"), false), {
    reason: "unknown",
    message: "Blitz could not finish that reply. Try again.",
  })
})

test("timeout, cancellation and invalid settings retain their recovery instructions", () => {
  assert.match(
    workspaceChatFailure(new CardChatError("timeout", "Timeout"), true).message,
    /took too long.*context is saved/
  )
  assert.match(
    workspaceChatFailure(new CardChatError("aborted", "Aborted"), false)
      .message,
    /interrupted.*Try again/
  )
  const invalid = new SavedModelSettingsError("Choose a supported model")
  assert.equal(workspaceChatFailure(invalid, true).message, invalid.message)
  const input = new CardChatError("invalid-input", "Choose a supported model")
  assert.equal(workspaceChatFailure(input, false).message, input.message)
})
