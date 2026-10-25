/**
 * Checks the one table of runtime features per provider, and that a turn
 * request loses exactly the options its provider cannot take, so OpenCode's
 * ACP engine never receives a reply schema, caps, plan mode, files, fork,
 * compaction, rewind, or a context usage read.
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { providerThreadFeatures } from "../lib/provider-thread-features.ts"
import { supportedTurnRequest } from "../lib/server/providers/run-text-turn.ts"

/** A turn that asks for every optional runtime feature. */
const EVERYTHING = {
  workspaceDirectory: "/tmp/blitz-features-test",
  prompt: "Question",
  outputSchema: { type: "object" },
  mode: "plan" as const,
  files: [{ path: "/tmp/blitz-features-test/paper.pdf" }],
  fork: { threadId: "thread-1", throughTurnId: "turn-1" },
  compactFirst: true,
  compactedPrompt: "Restated",
  rewindBeforeTurnId: "turn-2",
  readContextUsage: true,
}

test("Codex and Claude Code support every runtime feature apart from caps on Codex", () => {
  for (const providerId of ["codex", "claude-code"]) {
    const features = providerThreadFeatures(providerId)
    for (const [name, supported] of Object.entries(features))
      if (name !== "spendingCaps") assert.equal(supported, true, `${providerId} ${name}`)
  }
  assert.equal(providerThreadFeatures("codex").spendingCaps, false)
  assert.equal(providerThreadFeatures("claude-code").spendingCaps, true)
})

test("OpenCode and unknown providers support none of them", () => {
  for (const providerId of ["opencode", "something-else", undefined, null])
    for (const [name, supported] of Object.entries(providerThreadFeatures(providerId)))
      assert.equal(supported, false, `${providerId} ${name}`)
})

test("a Codex or Claude Code turn keeps every option it asked for", () => {
  for (const providerId of ["codex", "claude-code"] as const)
    assert.deepEqual(supportedTurnRequest({ ...EVERYTHING, providerId }), {
      ...EVERYTHING,
      providerId,
    })
})

test("an OpenCode turn keeps only the options its ACP engine takes", () => {
  assert.deepEqual(supportedTurnRequest({ ...EVERYTHING, providerId: "opencode" }), {
    providerId: "opencode",
    workspaceDirectory: EVERYTHING.workspaceDirectory,
    prompt: "Question",
  })
})

test("a compacted prompt is dropped with the compaction it belongs to", () => {
  const { compactFirst: _compactFirst, ...rest } = EVERYTHING
  const request = supportedTurnRequest({ ...rest, providerId: "codex" })
  assert.equal(request.compactFirst, undefined)
  assert.equal(request.compactedPrompt, undefined)
})
