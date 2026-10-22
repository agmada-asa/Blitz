/**
 * Creates the agent-engines runtimes Blitz drives and maps their sign-in and
 * model catalogue into Blitz's provider shapes.
 *
 * Codex (through `codex app-server`) and Claude Code (through the Claude Agent
 * SDK) both come from the shared agent-engines library. Blitz decides how each
 * engine is launched: which executable, which environment, and that it runs on
 * whatever sign-in the learner has, subscription or API key. Each turn and each
 * check gets its own engine and closes it, so no agent process outlives the
 * request that started it.
 */

import {
  ClaudeEngine,
  CodexEngine,
  type Availability,
  type CodexEngineOptions,
  type Engine,
  type ModelInfo,
} from "agent-engines"

import type { AiReasoningEffort } from "../../ai-model-settings.ts"
import { providerCommand } from "./registry.ts"
import type { ProviderAvailability, ProviderModelOption } from "./types.ts"

/** Providers Blitz runs through agent-engines. OpenCode stays on Blitz's ACP adapter. */
export type EngineProviderId = "codex" | "claude-code"

/** Reasoning tokens a provider may report; unknown future values are kept when well formed. */
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

/** Returns whether a Blitz provider runs through agent-engines. */
export function isEngineProvider(
  providerId: string
): providerId is EngineProviderId {
  return providerId === "codex" || providerId === "claude-code"
}

/**
 * Returns the environment for one engine: the server's own, as a plain record.
 *
 * @param withoutEffortOverride - Drops `CLAUDE_CODE_EFFORT_LEVEL`, so an
 *   inherited override cannot silently win over the saved selection.
 */
function engineEnvironment(
  withoutEffortOverride = false
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  if (withoutEffortOverride) delete env.CLAUDE_CODE_EFFORT_LEVEL
  return env
}

/**
 * Creates a Codex engine on the configured `codex` executable.
 *
 * Blitz lets the learner choose how Codex is signed in, so an API key is
 * allowed. Nothing starts until the engine is first used; callers close it.
 *
 * @param options - Process-wide launch flags and the host tool handler.
 */
export function createCodexEngine(
  options: Pick<CodexEngineOptions, "launch" | "onToolCall"> = {}
): CodexEngine {
  return new CodexEngine({
    executable: providerCommand("codex").executable,
    env: engineEnvironment(),
    requireSubscription: false,
    clientName: "blitz",
    ...options,
  })
}

/**
 * Creates a Claude engine on the configured `claude` executable, the same one
 * Blitz's sign-in buttons run, so both see one installation and account.
 *
 * @param options - Whether a saved effort is set, which drops any inherited
 *   effort override from the environment.
 */
export function createClaudeEngine(
  options: { effortSelected?: boolean } = {}
): ClaudeEngine {
  return new ClaudeEngine({
    executable: providerCommand("claude-code").executable,
    env: engineEnvironment(options.effortSelected === true),
    requireSubscription: false,
  })
}

/** Creates the engine for one Blitz provider. */
export function createProviderEngine(providerId: EngineProviderId): Engine {
  return providerId === "codex" ? createCodexEngine() : createClaudeEngine()
}

/** Normalizes a provider effort token while preserving newly added values. */
function normalizeReasoningEffort(
  value: string
): AiReasoningEffort | undefined {
  const effort = value.trim().toLowerCase()
  return REASONING_EFFORT_PATTERN.test(effort)
    ? (effort as AiReasoningEffort)
    : undefined
}

/**
 * Maps one catalogue entry into Blitz's provider-neutral model option.
 *
 * @returns The option, or undefined for an entry with no usable ID or one the
 *   runtime hides from its own picker.
 */
export function providerModelOption(
  model: ModelInfo
): ProviderModelOption | undefined {
  const id = model.id.trim()
  if (!id || model.hidden) return undefined
  const efforts = [
    ...new Set(
      model.efforts
        .map(normalizeReasoningEffort)
        .filter((effort): effort is AiReasoningEffort => effort !== undefined)
    ),
  ]
  const fallbackEffort = model.defaultEffort
    ? (normalizeReasoningEffort(model.defaultEffort) ?? "default")
    : "default"
  return {
    id,
    label: model.label.trim() || id,
    reasoningEfforts: efforts.length ? efforts : [fallbackEffort],
    inputModalities: (model.inputModalities ?? []).filter(
      (modality): modality is "text" | "image" | "audio" =>
        modality === "text" || modality === "image" || modality === "audio"
    ),
    ...(model.isDefault ? { isDefault: true } : {}),
  }
}

/** Maps a catalogue into Blitz options, dropping hidden and duplicate entries. */
export function providerModelOptions(
  models: readonly ModelInfo[]
): readonly ProviderModelOption[] {
  const seen = new Set<string>()
  const options: ProviderModelOption[] = []
  for (const model of models) {
    const option = providerModelOption(model)
    if (!option || seen.has(option.id)) continue
    seen.add(option.id)
    options.push(option)
  }
  return options
}

/**
 * Maps an engine's availability into the setup state the settings page shows.
 *
 * A signed-out runtime is installed but not connected, so the sign-in action
 * stays available. Blitz allows API keys, so `api-key` never blocks.
 *
 * @param providerId - Blitz provider being checked.
 * @param instanceId - Local profile key reported back to the settings page.
 * @param state - Result of `Engine.availability()`.
 */
export function providerAvailabilityFromEngine(
  providerId: EngineProviderId,
  instanceId: string,
  state: Availability
): ProviderAvailability {
  const base = { providerId, providerInstanceId: instanceId }
  switch (state.reason) {
    case "ready":
    case "api-key":
      return {
        ...base,
        available: true,
        authenticated: true,
        canDisconnect: true,
        reason: "ready",
        message: "Connected and ready.",
      }
    case "signed-out":
      return {
        ...base,
        available: true,
        authenticated: false,
        canDisconnect: false,
        reason: "missing-auth",
        message: "Installed, but not connected to Blitz.",
      }
    case "missing-executable":
      return {
        ...base,
        available: false,
        authenticated: null,
        reason: "missing-executable",
        message: "Install this provider before connecting it to Blitz.",
      }
    case "unsupported-version":
      return {
        ...base,
        available: false,
        authenticated: null,
        reason: "unsupported",
        message: `${state.message} Update it, then check again.`,
      }
    case "probe-failed":
      return {
        ...base,
        available: false,
        authenticated: null,
        reason: "probe-failed",
        message: `${providerId} did not pass its local runtime check.`,
      }
  }
}
