/** Verifies the browser cache of live provider model catalogs rejects stale and malformed data. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_PROVIDER_MODELS,
  PROVIDER_MODEL_CACHE_MAX_AGE_MS,
  parseCachedProviderModels,
  serializeProviderModels,
} from "../lib/client/provider-model-cache.ts"

const SOL = {
  id: "gpt-6.1-sol",
  label: "GPT-6.1-Sol",
  reasoningEfforts: ["low", "high"],
  inputModalities: ["text", "image"] as ("text" | "image")[],
  isDefault: true,
}

/** Keeps the fields the picker reads through a save and load. */
test("round-trips live catalogs", () => {
  const raw = serializeProviderModels(
    [{ providerId: "codex", models: [SOL] }, { providerId: "claude-code" }],
    1_000
  )
  assert.ok(raw)
  assert.deepEqual(parseCachedProviderModels(raw, 2_000), { codex: [SOL] })
})

/** An empty response must not replace a useful cache. */
test("skips saving when no provider reported models", () => {
  assert.equal(
    serializeProviderModels([{ providerId: "codex", models: [] }]),
    undefined
  )
})

/** Expired, malformed, or foreign entries never reach the picker. */
test("ignores stale, malformed, and unknown entries", () => {
  const raw = serializeProviderModels(
    [{ providerId: "codex", models: [SOL] }],
    0
  )
  assert.equal(
    parseCachedProviderModels(raw ?? null, PROVIDER_MODEL_CACHE_MAX_AGE_MS + 1),
    EMPTY_PROVIDER_MODELS
  )
  assert.equal(parseCachedProviderModels("not json"), EMPTY_PROVIDER_MODELS)
  assert.equal(parseCachedProviderModels(null), EMPTY_PROVIDER_MODELS)
  assert.deepEqual(
    parseCachedProviderModels(
      JSON.stringify({
        savedAt: 10,
        providers: {
          codex: [
            {
              id: "gpt-6-luna",
              label: "GPT-6-Luna",
              inputModalities: ["text", "video"],
            },
            { id: "", label: "No ID" },
            { label: "Missing ID" },
          ],
          unknown: [SOL],
        },
      }),
      20
    ),
    {
      codex: [
        { id: "gpt-6-luna", label: "GPT-6-Luna", inputModalities: ["text"] },
      ],
    }
  )
})
