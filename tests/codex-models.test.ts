/** Verifies native Codex model normalization and preflight capability checks. */

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  normalizeCodexModel,
  validateCodexModelSelection,
} from "../lib/server/providers/codex-models.ts"
import { runProviderTextTurn } from "../lib/server/providers/run-text-turn.ts"
import { CardChatError } from "../lib/server/card-chat.ts"

/** Builds the smallest native model fixture needed by the catalog parser. */
function nativeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "spark-id",
    model: "gpt-spark",
    displayName: "Spark",
    supportedReasoningEfforts: [
      { reasoningEffort: "none", description: "No reasoning" },
      { reasoningEffort: "minimal", description: "Minimal reasoning" },
      { reasoningEffort: "future-level", description: "Unknown" },
    ],
    defaultReasoningEffort: "minimal",
    inputModalities: ["text"],
    hidden: false,
    isDefault: true,
    ...overrides,
  }
}

test("normalizes native reasoning, modalities, hidden state, and default metadata", () => {
  const option = normalizeCodexModel(nativeModel() as never)
  assert.deepEqual(option, {
    id: "gpt-spark",
    label: "Spark",
    reasoningEfforts: ["none", "minimal"],
    inputModalities: ["text"],
    isDefault: true,
  })
  assert.equal(
    normalizeCodexModel(nativeModel({ hidden: true }) as never)?.id,
    "gpt-spark"
  )
})

test("rejects unknown model, effort, and unsupported image input", () => {
  const option = normalizeCodexModel(nativeModel() as never)
  assert.ok(option)
  assert.throws(() => validateCodexModelSelection([option], { model: "other" }))
  assert.throws(() =>
    validateCodexModelSelection([option], {
      model: "gpt-spark",
      effort: "high",
    })
  )
  assert.throws(() =>
    validateCodexModelSelection([option], { model: "gpt-spark" }, true)
  )
  assert.equal(
    validateCodexModelSelection([option], {
      model: "gpt-spark",
      effort: "minimal",
    }).id,
    "gpt-spark"
  )
})

test("custom Codex transports still receive runtime catalog preflight", async () => {
  let transportCreated = false
  await assert.rejects(
    runProviderTextTurn(
      {
        providerId: "codex",
        model: "gpt-spark",
        effort: "high",
        workspaceDirectory: "/tmp/blitz-owned-workspace",
        prompt: "Question",
      },
      {
        codexModelCatalog: [normalizeCodexModel(nativeModel() as never)!],
        createCodexTransport: () => {
          transportCreated = true
          throw new Error("transport should not be created")
        },
      }
    ),
    (error: unknown) =>
      error instanceof CardChatError &&
      error.reason === "invalid-input" &&
      /reasoning level/.test(error.message)
  )
  assert.equal(transportCreated, false)
})
