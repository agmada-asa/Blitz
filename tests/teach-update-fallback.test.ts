/**
 * Covers a lesson update moving to another provider when the lesson's own is
 * at a usage limit: the order providers are tried in, which failures move it
 * on, and what is reported when none can do it. No runtime process or model
 * turn is used; the provider checks and turns are stand-ins.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import type { AiProviderId } from "../lib/ai-model-settings.ts"
import { updateFallbackProviders, type HandoffAvailability } from "../lib/provider-handoff.ts"
import { CardChatError } from "../lib/server/card-chat.ts"
import {
  runWithLimitFallback,
  stoppedAtLimit,
  type UpdateSelection,
} from "../lib/server/teach-update-fallback.ts"

/** Builds a provider check that is installed and signed in, or not. */
function check(providerId: string, ready = true): HandoffAvailability {
  return { providerId, available: ready, authenticated: ready }
}

/** A usage-limit error shaped like the one a provider turn throws. */
function limitError(): CardChatError {
  return new CardChatError("usage-limit", "You've reached the selected provider's usage limit.")
}

/** Runs the fallback with stand-in providers that fail as `outcomes` says. */
async function runWith(
  outcomes: Partial<Record<AiProviderId, Error>>,
  checks: readonly HandoffAvailability[] = [
    check("codex"),
    check("claude-code"),
    check("opencode"),
    check("antigravity", false),
  ],
  configuredProviderId: AiProviderId = "claude-code"
) {
  const tried: UpdateSelection[] = []
  let checked = 0
  const outcome = await runWithLimitFallback({
    lesson: { providerId: "codex", model: "lesson-model", effort: "high" },
    configuredProviderId,
    selectionFor: (providerId) => ({ providerId, model: "default" }),
    checkProviders: async () => {
      checked += 1
      return checks
    },
    run: async (selection) => {
      tried.push(selection)
      const error = outcomes[selection.providerId]
      if (error) throw error
      return `reply from ${selection.providerId}`
    },
  }).catch((error: unknown) => ({ error }))
  return { outcome, tried: tried.map((selection) => selection.providerId), checked, selections: tried }
}

test("updateFallbackProviders puts the Settings provider first and skips the one at its limit", () => {
  const checks = [check("codex"), check("claude-code"), check("opencode")]
  assert.deepEqual(updateFallbackProviders("codex", "opencode", checks), ["opencode", "claude-code"])
  assert.deepEqual(updateFallbackProviders("codex", "codex", checks), ["claude-code", "opencode"])
})

test("updateFallbackProviders leaves out providers that are not signed in", () => {
  const checks = [
    check("codex"),
    check("claude-code", false),
    { providerId: "opencode", available: true, authenticated: null },
  ]
  assert.deepEqual(updateFallbackProviders("codex", "claude-code", checks), [])
})

test("stoppedAtLimit recognises usage, rate and quota limits only", () => {
  assert.equal(stoppedAtLimit(limitError()), true)
  assert.equal(stoppedAtLimit(new CardChatError("rate-limit", "Slow down")), true)
  assert.equal(stoppedAtLimit(new Error("You exceeded your current quota")), true)
  assert.equal(stoppedAtLimit(new CardChatError("timeout", "Took too long")), false)
  assert.equal(stoppedAtLimit(new Error("Unexpected JSON")), false)
  assert.equal(stoppedAtLimit("usage limit"), false)
})

test("the lesson's own provider does the update when it can, without checking others", async () => {
  const { outcome, tried, checked, selections } = await runWith({})
  assert.deepEqual(outcome, { result: "reply from codex", providerId: "codex" })
  assert.deepEqual(tried, ["codex"])
  assert.equal(checked, 0)
  assert.deepEqual(selections[0], { providerId: "codex", model: "lesson-model", effort: "high" })
})

test("a lesson at its provider's limit is updated by the Settings provider", async () => {
  const { outcome, tried, selections } = await runWith({ codex: limitError() })
  assert.deepEqual(outcome, { result: "reply from claude-code", providerId: "claude-code" })
  assert.deepEqual(tried, ["codex", "claude-code"])
  assert.deepEqual(selections[1], { providerId: "claude-code", model: "default" })
})

test("the update keeps moving while each provider is at its limit", async () => {
  const { outcome, tried } = await runWith({ codex: limitError(), "claude-code": limitError() })
  assert.deepEqual(outcome, { result: "reply from opencode", providerId: "opencode" })
  assert.deepEqual(tried, ["codex", "claude-code", "opencode"])
})

test("the lesson provider's limit is reported when every provider is at its limit", async () => {
  const original = limitError()
  const { outcome, tried } = await runWith({
    codex: original,
    "claude-code": limitError(),
    opencode: limitError(),
  })
  assert.deepEqual(outcome, { error: original })
  assert.deepEqual(tried, ["codex", "claude-code", "opencode"])
})

test("the lesson provider's limit is reported when no other provider is signed in", async () => {
  const original = limitError()
  const { outcome, tried } = await runWith({ codex: original }, [check("codex"), check("claude-code", false)])
  assert.deepEqual(outcome, { error: original })
  assert.deepEqual(tried, ["codex"])
})

test("other failures do not move the update to another provider", async () => {
  const timeout = new CardChatError("timeout", "Took too long")
  const { outcome, tried, checked } = await runWith({ codex: timeout })
  assert.deepEqual(outcome, { error: timeout })
  assert.deepEqual(tried, ["codex"])
  assert.equal(checked, 0)
})

test("a fallback's own non-limit failure is reported instead of the limit", async () => {
  const broken = new Error("The update came back as invalid JSON")
  const { outcome, tried } = await runWith({ codex: limitError(), "claude-code": broken })
  assert.deepEqual(outcome, { error: broken })
  assert.deepEqual(tried, ["codex", "claude-code"])
})
