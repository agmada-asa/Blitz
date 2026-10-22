/** Verifies Codex catalogue mapping and preflight capability checks. */

import assert from "node:assert/strict"
import { test } from "node:test"
import type { ModelInfo } from "agent-engines"
import { validateCodexModelSelection } from "../lib/server/providers/codex-models.ts"
import {
  providerModelOption,
  providerModelOptions,
} from "../lib/server/providers/engines.ts"
import { runProviderTextTurn } from "../lib/server/providers/run-text-turn.ts"
import { CardChatError } from "../lib/server/card-chat.ts"

/** Builds the smallest catalogue entry the mapper reads. */
function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "gpt-spark",
    label: "Spark",
    efforts: ["none", "minimal", "future-level"],
    defaultEffort: "minimal",
    fastMode: false,
    isDefault: true,
    inputModalities: ["text"],
    ...overrides,
  }
}

// Provider-published levels are kept, including ones Blitz has no label for,
// so a new reasoning level works without an app update.
test("maps native reasoning, modalities, and default metadata, and drops hidden models", () => {
  assert.deepEqual(providerModelOption(model()), {
    id: "gpt-spark",
    label: "Spark",
    reasoningEfforts: ["none", "minimal", "future-level"],
    inputModalities: ["text"],
    isDefault: true,
  })
  assert.equal(providerModelOption(model({ hidden: true })), undefined)
  assert.deepEqual(
    providerModelOption(model({ efforts: [], defaultEffort: undefined }))
      ?.reasoningEfforts,
    ["default"]
  )
  assert.deepEqual(
    providerModelOptions([model(), model({ label: "Again" })]).length,
    1
  )
})

test("rejects unknown model, effort, and unsupported image input", () => {
  const option = providerModelOption(model())
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

test("an unsupported Codex effort fails before any thread starts", async () => {
  let threadStarted = false
  let closed = false
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
        codexModelCatalog: [providerModelOption(model())!],
        createEngine: () =>
          ({
            provider: "codex",
            startThread: async () => {
              threadStarted = true
              throw new Error("thread should not start")
            },
            close: async () => {
              closed = true
            },
          }) as never,
      }
    ),
    (error: unknown) =>
      error instanceof CardChatError &&
      error.reason === "invalid-input" &&
      /reasoning level/.test(error.message)
  )
  assert.equal(threadStarted, false)
  assert.equal(closed, true)
})
