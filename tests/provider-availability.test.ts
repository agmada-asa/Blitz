/** Checks local provider probes and setup-state mapping without model or account requests. */

import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import {
  checkProviderAvailability,
  parseOpenCodeIntegrations,
} from "../lib/server/providers/registry.ts"
import { providerAvailabilityFromEngine } from "../lib/server/providers/engines.ts"

/** Reads OpenCode v2's JSON credential list into names and credential IDs only. */
test("parses configured OpenCode integrations without credential data", () => {
  const output = JSON.stringify([
    {
      id: "google",
      name: "Google",
      connections: [
        { type: "credential", id: "cred_a", label: "API key", method: "key" },
      ],
    },
    {
      id: "openai",
      name: "OpenAI",
      connections: [
        { type: "credential", id: "cred_b", label: "OAuth", method: "oauth" },
      ],
    },
    // An integration with nothing saved is not an account.
    { id: "github", name: "GitHub", connections: [] },
  ])
  assert.deepEqual(parseOpenCodeIntegrations(output), [
    { id: "google", name: "Google", credentialIds: ["cred_a"] },
    { id: "openai", name: "OpenAI", credentialIds: ["cred_b"] },
  ])
  assert.deepEqual(parseOpenCodeIntegrations("Google  API key  stored"), [])
  assert.deepEqual(parseOpenCodeIntegrations("{}"), [])
})

/** Engine sign-in states map onto the settings page's setup states. */
test("maps engine availability onto Blitz setup states", () => {
  const signedOut = providerAvailabilityFromEngine("codex", "local", {
    provider: "codex",
    ready: false,
    reason: "signed-out",
    message: "Codex is not signed in.",
  })
  assert.equal(signedOut.available, true)
  assert.equal(signedOut.authenticated, false)
  assert.equal(signedOut.reason, "missing-auth")
  const old = providerAvailabilityFromEngine("claude-code", "local", {
    provider: "claude",
    ready: false,
    reason: "unsupported-version",
    message: "Claude Code 2.1.247 is too old: 2.1.248 or newer is required.",
  })
  assert.equal(old.available, false)
  assert.equal(old.reason, "unsupported")
  assert.match(old.message, /2\.1\.248/)
  // Blitz lets the learner run on an API key.
  const apiKey = providerAvailabilityFromEngine("claude-code", "local", {
    provider: "claude",
    ready: true,
    reason: "ready",
    message: "Claude is signed in.",
    account: { kind: "api-key" },
  })
  assert.equal(apiKey.available && apiKey.authenticated, true)
  // An API key is reported, so Settings can offer spending limits.
  assert.equal(apiKey.billing, "api-key")
  assert.match(apiKey.message, /API key, billed per token/)
  const subscription = providerAvailabilityFromEngine("codex", "local", {
    provider: "codex",
    ready: true,
    reason: "ready",
    message: "Codex is signed in with ChatGPT.",
    account: { kind: "subscription", plan: "plus" },
  })
  assert.equal(subscription.billing, "subscription")
  assert.equal(subscription.message, "Connected and ready.")
})

/** A missing Codex or Claude Code executable is reported without a model call. */
test("reports missing engine executables before a turn starts", async () => {
  for (const [provider, key] of [
    ["codex", "BLITZ_CODEX_COMMAND"],
    ["claude-code", "BLITZ_CLAUDE_CODE_COMMAND"],
  ] as const) {
    const original = process.env[key]
    try {
      process.env[key] = "/nonexistent/blitz/provider"
      const result = await checkProviderAvailability(provider, {
        workspaceDirectory: tmpdir(),
      })
      assert.equal(result.available, false)
      assert.equal(result.reason, "missing-executable")
    } finally {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  }
})

/** Native ACP availability depends on installation instead of a blanket provider ban. */
test("reports missing ACP executables with actionable setup guidance", async () => {
  for (const [provider, key] of [
    ["opencode", "BLITZ_OPENCODE_COMMAND"],
  ] as const) {
    const original = process.env[key]
    try {
      process.env[key] = "/nonexistent/blitz/provider"
      const result = await checkProviderAvailability(provider, {
        workspaceDirectory: tmpdir(),
      })
      assert.equal(result.available, false)
      assert.equal(result.reason, "missing-executable")
    } finally {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  }
})
