/** Tests provider-aware validation and fallback behavior for task-specific model selections. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveProviderApprovalPolicy,
  validateProviderApprovalPolicies,
  getSupportedAiReasoningEffortsForProvider,
  CODEX_MODEL_OPTIONS,
  DEFAULT_AI_MODEL_SETTINGS,
  DEFAULT_AI_MODELS,
  getDefaultAiModelOption,
  getAiProviderOptionsForTask,
  getSupportedAiReasoningEfforts,
  isLegacyAiModelOption,
  groupCodexModelOptions,
  resolveAiTaskSelection,
  resolveAiModel,
  resolveAiReasoningEffort,
  validateAiModelSettings,
  validateAiTaskProviders,
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
      researchModel: " gpt-6-luna ",
      replyModel: "gpt-6-luna",
      cardGenerationModel: "gpt-6-luna",
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

/** Confirms provider fields default legacy records to Codex and retain alternate choices. */
test("validates provider-aware task selections", () => {
  const settings = validateAiModelSettings({
    researchModel: "gpt-5.6-luna",
    replyModel: "claude-sonnet",
    cardGenerationModel: "opencode/big-pickle",
    researchEffort: "medium",
    replyEffort: "high",
    cardGenerationEffort: "default",
    replyProvider: "claude-code",
    cardGenerationProvider: "opencode",
  })
  assert.equal(settings.researchProvider, "codex")
  assert.equal(settings.replyProvider, "claude-code")
  assert.equal(settings.cardGenerationProvider, "opencode")
})

/** Confirms switching providers starts with a model owned by the new provider. */
test("selects a provider-owned default model", () => {
  assert.equal(getDefaultAiModelOption("codex").id, "gpt-6-luna")
  assert.equal(getDefaultAiModelOption("claude-code").id, "sonnet")
  assert.equal(getDefaultAiModelOption("opencode").id, "opencode/big-pickle")
  assert.equal(getDefaultAiModelOption("antigravity").id, "antigravity/default")
})

/** Confirms research stays on providers whose reviewed capabilities include web search. */
test("filters providers by task capability", () => {
  assert.deepEqual(
    getAiProviderOptionsForTask("research").map((option) => option.id),
    ["codex"]
  )
  assert.deepEqual(
    getAiProviderOptionsForTask("reply").map((option) => option.id),
    ["codex", "claude-code", "opencode", "antigravity"]
  )
})

/** Confirms task routing keeps each provider paired with its own saved model and controls. */
test("resolves a provider selection for each task", () => {
  const settings = validateAiModelSettings({
    researchModel: "gpt-5.6-luna",
    replyModel: "claude-sonnet",
    cardGenerationModel: "antigravity/default",
    researchEffort: "medium",
    replyEffort: "high",
    cardGenerationEffort: "default",
    researchProvider: "codex",
    replyProvider: "claude-code",
    cardGenerationProvider: "antigravity",
  })
  assert.deepEqual(resolveAiTaskSelection(settings, "reply"), {
    providerId: "claude-code",
    model: "claude-sonnet",
    effort: "high",
  })
  assert.deepEqual(resolveAiTaskSelection(settings, "cardGeneration"), {
    providerId: "antigravity",
    model: "antigravity/default",
    effort: "default",
  })
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
      }, {
        codex: [
          {
            id: "gpt-5.6-luna",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      }),
    /not available/
  )
})

/** Confirms settings reject malformed reasoning effort tokens. */
test("rejects malformed reasoning effort values", () => {
  assert.throws(
    () =>
      validateAiModelSettings({
        researchModel: "gpt-5.6-luna",
        replyModel: "claude-sonnet",
        cardGenerationModel: "opencode/big-pickle",
        researchEffort: "medium",
        replyEffort: "high effort",
        cardGenerationEffort: "medium",
        replyProvider: "claude-code",
        cardGenerationProvider: "opencode",
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
    ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]
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

/** Confirms Antigravity keeps only the newest reported Gemini generation above the fold. */
test("classifies older Antigravity generations as legacy", () => {
  const options = [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
  ]
  assert.equal(isLegacyAiModelOption("antigravity", options[0], options), false)
  assert.equal(isLegacyAiModelOption("antigravity", options[1], options), false)
  assert.equal(isLegacyAiModelOption("antigravity", options[2], options), true)
  assert.equal(isLegacyAiModelOption("antigravity", options[3], options), true)
})

/** Confirms unsupported reasoning settings become explicit provider defaults. */
test("does not advertise ignored ACP or Haiku reasoning controls", () => {
  assert.deepEqual(
    getSupportedAiReasoningEffortsForProvider("opencode", "default"),
    ["default"]
  )
  assert.deepEqual(
    getSupportedAiReasoningEffortsForProvider("claude-code", "haiku"),
    ["default"]
  )
})

/** Confirms per-provider approval choices survive validation and unsupported grants fail closed. */
test("validates and resolves provider approval policies", () => {
  for (const policy of ["on-request", "untrusted", "full-access"] as const) {
    const settings = validateAiModelSettings({
      ...DEFAULT_AI_MODEL_SETTINGS,
      providerApprovalPolicies: { codex: policy },
    })
    assert.equal(resolveProviderApprovalPolicy(settings, "codex"), policy)
    assert.equal(
      resolveProviderApprovalPolicy(settings, "claude-code"),
      "never"
    )
  }
  assert.throws(
    () => validateProviderApprovalPolicies({ "claude-code": "untrusted" }),
    /not supported/
  )
  assert.throws(
    () => validateProviderApprovalPolicies({ opencode: "bypassPermissions" }),
    /not supported/
  )
})

/** All providers expose native access choices while unsupported background assignments remain unsavable. */
test("validates native provider access choices and task restrictions", () => {
  for (const provider of ["claude-code", "opencode"] as const) {
    for (const policy of ["never", "on-request", "full-access"] as const) {
      assert.equal(
        validateProviderApprovalPolicies({ [provider]: policy })[provider],
        policy
      )
    }
  }
  const legacy = validateAiModelSettings({
    ...DEFAULT_AI_MODEL_SETTINGS,
    cardGenerationProvider: "antigravity",
    cardGenerationModel: "antigravity/default",
    cardGenerationEffort: "default",
  })
  assert.throws(() => validateAiTaskProviders(legacy), /workspace chat only/)
  assert.ok(
    !getAiProviderOptionsForTask("cardGeneration").some(
      (provider) => provider.id === "antigravity"
    )
  )
})

/** Keeps access-level menus ordered from least to most dangerous top-to-bottom. */
test("matches each provider's native access-level options", async () => {
  const { AI_PROVIDER_APPROVAL_POLICIES } = await import(
    "../lib/ai-model-settings.ts"
  )

  assert.deepEqual(AI_PROVIDER_APPROVAL_POLICIES.codex, [
    "on-request",
    "untrusted",
    "full-access",
  ])
  for (const provider of ["claude-code", "opencode"] as const) {
    assert.deepEqual(AI_PROVIDER_APPROVAL_POLICIES[provider], [
      "never",
      "on-request",
      "full-access",
    ])
  }
  assert.deepEqual(AI_PROVIDER_APPROVAL_POLICIES.antigravity, [
    "on-request",
    "full-access",
  ])
})
