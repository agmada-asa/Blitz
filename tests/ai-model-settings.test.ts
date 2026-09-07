/** Tests validation and fallback behavior for task-specific Codex model selections. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  CODEX_MODEL_OPTIONS,
  DEFAULT_AI_MODEL_SETTINGS,
  DEFAULT_AI_MODELS,
  getSupportedAiReasoningEfforts,
  groupCodexModelOptions,
  resolveAiModel,
  resolveAiReasoningEffort,
  validateAiModelSettings,
  type AiModelSettings,
} from "../lib/ai-model-settings.ts"

/** Confirms the saved choice takes precedence over the existing worker-wide fallback. */
test("uses a saved model for its matching AI task", () => {
  const settings: AiModelSettings = {
    researchModel: "gpt-research",
    replyModel: "gpt-replies",
    cardGenerationModel: "gpt-cards",
    researchEffort: "high",
    replyEffort: "medium",
    cardGenerationEffort: "low",
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
  assert.equal(resolveAiModel(null, "replyModel", "gpt-legacy"), "gpt-legacy")
  assert.equal(resolveAiModel(null, "replyModel"), DEFAULT_AI_MODELS.replyModel)
})

/** Confirms complete selections normalize model IDs and retain their chosen reasoning levels. */
test("validates complete model and reasoning settings", () => {
  assert.deepEqual(
    validateAiModelSettings({
      researchModel: " gpt-5.6-luna ",
      replyModel: "gpt-5.6-luna",
      cardGenerationModel: "gpt-5.6-luna",
      researchEffort: "medium",
      replyEffort: "low",
      cardGenerationEffort: "medium",
    }),
    { ...DEFAULT_AI_MODEL_SETTINGS }
  )
  assert.throws(
    () =>
      validateAiModelSettings({
        researchModel: "gpt research",
        replyModel: "gpt-5.6-luna",
        cardGenerationModel: "gpt-5.6-luna",
        researchEffort: "medium",
        replyEffort: "medium",
        cardGenerationEffort: "medium",
      }),
    /unsupported characters/
  )
})

/** Confirms a selected model cannot be saved with a reasoning level it does not support. */
test("rejects an unsupported model and reasoning combination", () => {
  assert.throws(
    () =>
      validateAiModelSettings({
        researchModel: "gpt-5.6-luna",
        replyModel: "gpt-5.6-luna",
        cardGenerationModel: "gpt-5.6-luna",
        researchEffort: "ultra",
        replyEffort: "medium",
        cardGenerationEffort: "medium",
      }),
    /not available/
  )
})

/** Confirms the picker narrows reasoning levels when a selected model has fewer valid choices. */
test("returns compatible reasoning levels for each picker model", () => {
  assert.deepEqual(getSupportedAiReasoningEfforts("gpt-5.6-luna"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  assert.deepEqual(getSupportedAiReasoningEfforts("gpt-5.5"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ])
})

/** Confirms saved reasoning takes precedence over legacy environment configuration. */
test("uses saved reasoning and retains the legacy fallback before settings exist", () => {
  const settings = {
    ...DEFAULT_AI_MODEL_SETTINGS,
    replyEffort: "high" as const,
  }
  assert.equal(resolveAiReasoningEffort(settings, "replyEffort", "low"), "high")
  assert.equal(resolveAiReasoningEffort(null, "replyEffort", "low"), "low")
  assert.equal(
    resolveAiReasoningEffort(null, "replyEffort"),
    DEFAULT_AI_MODEL_SETTINGS.replyEffort
  )
})

/** Confirms model picker choices partition into distinct major and minor generations. */
test("groups models by major and minor generation with dividers", () => {
  const groups = groupCodexModelOptions(CODEX_MODEL_OPTIONS)

  assert.deepEqual(
    groups.map((group) => group.generation),
    ["GPT-6", "GPT-5.6", "GPT-5.5", "GPT-5.4", "GPT-5.3"]
  )

  const gpt6Group = groups.find((g) => g.generation === "GPT-6")
  assert.deepEqual(
    gpt6Group?.options.map((opt) => opt.id),
    ["gpt-6-astra"]
  )

  const gpt56Group = groups.find((g) => g.generation === "GPT-5.6")
  assert.deepEqual(
    gpt56Group?.options.map((opt) => opt.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  )

  const gpt55Group = groups.find((g) => g.generation === "GPT-5.5")
  assert.deepEqual(
    gpt55Group?.options.map((opt) => opt.id),
    ["gpt-5.5"]
  )

  const gpt54Group = groups.find((g) => g.generation === "GPT-5.4")
  assert.deepEqual(
    gpt54Group?.options.map((opt) => opt.id),
    ["gpt-5.4-mini"]
  )

  const gpt53Group = groups.find((g) => g.generation === "GPT-5.3")
  assert.deepEqual(
    gpt53Group?.options.map((opt) => opt.id),
    ["gpt-5.3-codex-spark"]
  )

  // Unrecognized labels fall into an "OTHER" group.
  const customGroups = groupCodexModelOptions([
    { id: "custom-worker", label: "Custom Worker", reasoningEfforts: ["low"] },
  ])
  assert.equal(customGroups[0]?.generation, "OTHER")
  assert.equal(customGroups[0]?.options[0]?.id, "custom-worker")
})
