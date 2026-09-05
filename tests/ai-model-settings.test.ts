/** Tests validation and fallback behavior for task-specific Codex model selections. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_AI_MODELS,
  resolveAiModel,
  validateAiModelSettings,
} from "../lib/ai-model-settings.ts"

/** Confirms the saved choice takes precedence over the existing worker-wide fallback. */
test("uses a saved model for its matching AI task", () => {
  const settings = {
    researchModel: "gpt-research",
    replyModel: "gpt-replies",
    cardGenerationModel: "gpt-cards",
  }

  assert.equal(
    resolveAiModel(settings, "researchModel", "gpt-legacy"),
    "gpt-research"
  )
  assert.equal(
    resolveAiModel(settings, "replyModel", "gpt-legacy"),
    "gpt-replies"
  )
  assert.equal(
    resolveAiModel(settings, "cardGenerationModel", "gpt-legacy"),
    "gpt-cards"
  )
})

/** Confirms legacy workers retain their configured model before a setting is saved. */
test("falls back to the legacy model and then Blitz defaults", () => {
  assert.equal(
    resolveAiModel(null, "replyModel", "gpt-legacy"),
    "gpt-legacy"
  )
  assert.equal(
    resolveAiModel(null, "replyModel"),
    DEFAULT_AI_MODELS.replyModel
  )
})

/** Confirms model IDs are trimmed and reject unsupported whitespace. */
test("validates complete model settings", () => {
  assert.deepEqual(
    validateAiModelSettings({
      researchModel: " gpt-5.6-luna ",
      replyModel: "gpt-5.6-luna",
      cardGenerationModel: "gpt-5.6-luna",
    }),
    { ...DEFAULT_AI_MODELS }
  )
  assert.throws(
    () =>
      validateAiModelSettings({
        researchModel: "gpt research",
        replyModel: "gpt-5.6-luna",
        cardGenerationModel: "gpt-5.6-luna",
      }),
    /unsupported characters/
  )
})
