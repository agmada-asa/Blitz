/** Verifies that model controls and environment descriptions reflect enforced adapter behavior. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  CHAT_PROVIDER_CAPABILITIES,
  getChatModelCapabilities,
  providerAccessChoice,
} from "../lib/provider-capabilities.ts"
import {
  providerExecutionInstructions,
  resolveProviderExecution,
} from "../lib/provider-execution.ts"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  validateAiModelSettings,
} from "../lib/ai-model-settings.ts"
import {
  loadSavedAiModelSettings,
  SavedModelSettingsError,
} from "../lib/server/ai-model-settings.ts"

/** Switching models must recompute reasoning support, including models with no effort setting. */
test("model switches narrow reasoning settings and retain conditional ACP image support", () => {
  assert.equal(
    getChatModelCapabilities("claude-code", "sonnet").reasoningEffort,
    true
  )
  assert.deepEqual(
    getChatModelCapabilities("claude-code", "haiku").reasoningEfforts,
    ["default"]
  )
  assert.equal(
    getChatModelCapabilities("opencode", "default").reasoningEffort,
    false
  )
  assert.equal(
    getChatModelCapabilities("antigravity", "antigravity/default").images,
    "negotiated"
  )
  assert.equal(CHAT_PROVIDER_CAPABILITIES.antigravity.structuredOutput, false)
})

/** A tool allowlist is never advertised as filesystem isolation. */
test("only Codex advertises enforced filesystem sandboxes", () => {
  for (const provider of ["claude-code", "opencode", "antigravity"] as const) {
    assert.deepEqual(CHAT_PROVIDER_CAPABILITIES[provider].sandboxModes, [])
    assert.throws(
      () =>
        resolveProviderExecution({
          providerId: provider,
          workspaceDirectory: "/workspace",
          sandbox: "workspace-write",
        }),
      /OS sandbox/
    )
  }
})

/** Environment facts change with sandbox and explicit bypass modes. */
test("Codex environment exposes roots, commands, network and approvals without widening reads", () => {
  const read = resolveProviderExecution({
    providerId: "codex",
    workspaceDirectory: "/workspace",
    sandbox: "read-only",
    approvalPolicy: "on-request",
  })
  assert.deepEqual(read.writableRoots, [])
  assert.equal(read.network, "disabled")
  assert.equal(read.commands, "sandboxed")
  const write = resolveProviderExecution({
    providerId: "codex",
    workspaceDirectory: "/workspace",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  })
  assert.deepEqual(write.writableRoots, ["/workspace"])
  assert.match(
    providerExecutionInstructions(write),
    /Requests for additional permission are denied/
  )
  const full = resolveProviderExecution({
    providerId: "codex",
    workspaceDirectory: "/workspace",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  })
  assert.equal(full.sandbox, "none")
  assert.equal(full.network, "host-permissions")
  assert.equal(full.writableRoots, "host-permissions")
})

/** Background isolation disables tool access instead of claiming the process is OS-sandboxed. */
test("non-Codex execution distinguishes disabled tools and native approval control", () => {
  for (const providerId of ["claude-code", "opencode"] as const) {
    const disabled = resolveProviderExecution({
      providerId,
      workspaceDirectory: "/workspace",
      ephemeral: true,
    })
    assert.equal(disabled.sandbox, "none")
    assert.equal(disabled.tools, "disabled")
    assert.equal(disabled.commands, "unavailable")
    const interactive = resolveProviderExecution({
      providerId,
      workspaceDirectory: "/workspace",
      approvalPolicy: "on-request",
    })
    assert.equal(interactive.commands, "permission-controlled")
    assert.match(
      providerExecutionInstructions(interactive),
      /working directory is not a filesystem security boundary/
    )
  }
  assert.throws(
    () =>
      resolveProviderExecution({
        providerId: "antigravity",
        workspaceDirectory: "/workspace",
        ephemeral: true,
      }),
    /tool-free/
  )
})

/** Unsupported settings produce an actionable failure, not an ignored setting or another provider. */
test("saving unsupported reasoning fails rather than silently defaulting", () => {
  for (const [replyProvider, replyModel] of [
    ["claude-code", "haiku"],
    ["opencode", "default"],
  ] as const) {
    assert.throws(
      () =>
        validateAiModelSettings({
          ...DEFAULT_AI_MODEL_SETTINGS,
          replyProvider,
          replyModel,
          replyEffort: "high",
        }),
      /not available/
    )
  }
  assert.doesNotMatch(
    providerAccessChoice("codex", "untrusted").label,
    /approve for me/i
  )
  assert.equal(
    providerAccessChoice("antigravity", "never").label,
    "Unavailable"
  )
})

/** Invalid persisted selections cannot silently send the user's prompt to a different provider. */
test("invalid saved settings fail explicitly while an unsaved installation uses defaults", async () => {
  assert.equal(await loadSavedAiModelSettings(null), null)
  await assert.rejects(
    loadSavedAiModelSettings({
      query: async () => ({
        ...DEFAULT_AI_MODEL_SETTINGS,
        replyProvider: "opencode",
        replyModel: "default",
        replyEffort: "high",
      }),
    } as never),
    SavedModelSettingsError
  )
  const settings = await loadSavedAiModelSettings({
    query: async () => ({
      ...DEFAULT_AI_MODEL_SETTINGS,
      replyProvider: "claude-code",
      replyModel: "haiku",
      replyEffort: "default",
    }),
  } as never)
  assert.equal(settings?.replyProvider, "claude-code")
  assert.equal(settings?.replyModel, "haiku")
})
