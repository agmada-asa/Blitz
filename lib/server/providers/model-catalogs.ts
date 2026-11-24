/**
 * Reads each provider's model catalogue for the signed-in account, so Auto
 * picks from the models the user's plan actually offers.
 *
 * Codex and OpenCode keep their own short-lived caches. Claude Code and
 * Antigravity are read here and reused for a few minutes: a plan change shows
 * up within that time, and a run of turns does not start a runtime each.
 */

import { tmpdir } from "node:os"
import {
  AUTO_AI_MODEL,
  resolveAutoAiModel,
  type AiProviderId,
  type AiReasoningEffort,
} from "../../ai-model-settings.ts"
import { createAntigravityEngine } from "./antigravity.ts"
import { getCodexModelCatalog } from "./codex-models.ts"
import {
  createClaudeEngine,
  providerModelOptions,
} from "./engines.ts"
import { listOpenCodeModels } from "./opencode.ts"
import type { ProviderModelOption } from "./types.ts"

/** How long a Claude Code or Antigravity catalogue is reused. */
const CATALOG_TTL_MS = 5 * 60_000

/** Longest wait for a catalogue. Antigravity asks its service, which takes about two seconds. */
const CATALOG_TIMEOUT_MS = 20_000

/** One cached catalogue per provider and when it stops being reused. */
const cache = new Map<
  AiProviderId,
  { readonly expiresAt: number; readonly models: readonly ProviderModelOption[] }
>()

/** Catalogue reads in flight, so concurrent turns share one. */
const loading = new Map<
  AiProviderId,
  Promise<readonly ProviderModelOption[]>
>()

/** Rejects when a read outlasts the timeout. */
async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not list its models in time`)),
          CATALOG_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Reads Claude Code's catalogue, keeping the default alias's effort metadata for Auto. */
async function listClaudeModels(): Promise<readonly ProviderModelOption[]> {
  const engine = createClaudeEngine()
  try {
    return providerModelOptions(await withTimeout(engine.models(), "Claude Code"))
  } finally {
    await engine.close().catch(() => undefined)
  }
}

/**
 * Reads Antigravity's catalogue from a sandboxed probe session, which starts
 * no conversation. Blitz sends ACP providers no reasoning level.
 */
async function listAntigravityModels(): Promise<
  readonly ProviderModelOption[]
> {
  const engine = createAntigravityEngine(
    { sandbox: "read-only", approvalPolicy: "never", webSearchMode: "disabled" },
    tmpdir()
  )
  try {
    return providerModelOptions(
      await withTimeout(engine.models(), "Antigravity")
    ).map((option) => ({ ...option, reasoningEfforts: ["default"] }))
  } finally {
    await engine.close().catch(() => undefined)
  }
}

/** Reads and caches a Claude Code or Antigravity catalogue. */
function cachedCatalog(
  providerId: "claude-code" | "antigravity"
): Promise<readonly ProviderModelOption[]> {
  const hit = cache.get(providerId)
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.models)
  const pending = loading.get(providerId)
  if (pending) return pending
  const load = (
    providerId === "claude-code" ? listClaudeModels() : listAntigravityModels()
  ).finally(() => loading.delete(providerId))
  loading.set(providerId, load)
  return load.then((models) => {
    cache.set(providerId, { models, expiresAt: Date.now() + CATALOG_TTL_MS })
    return models
  })
}

/**
 * Returns the signed-in account's model catalogue for one provider.
 *
 * @param providerId - The provider to read.
 * @returns Its models, or undefined when the runtime cannot list them.
 */
export async function readProviderModelCatalog(
  providerId: AiProviderId
): Promise<readonly ProviderModelOption[] | undefined> {
  const read =
    providerId === "codex"
      ? getCodexModelCatalog()
      : providerId === "opencode"
        ? listOpenCodeModels()
        : cachedCatalog(providerId)
  return read.catch((error: unknown) => {
    console.warn("Model catalogue could not be read for Auto", {
      providerId,
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return undefined
  })
}

/**
 * Replaces Auto in a turn's selection with the model it settles on for the
 * signed-in account. Any other selection is returned unchanged.
 *
 * @param selection - The turn's provider, model and effort.
 * @param readCatalog - Reads a provider's catalogue; tests pass a fake.
 */
export async function resolveAutoSelection<
  T extends { providerId: AiProviderId; model: string; effort?: AiReasoningEffort },
>(
  selection: T,
  readCatalog: typeof readProviderModelCatalog = readProviderModelCatalog
): Promise<T> {
  if (selection.model !== AUTO_AI_MODEL) return selection
  const resolved = resolveAutoAiModel(
    selection.providerId,
    selection.effort,
    await readCatalog(selection.providerId)
  )
  const next: T = { ...selection, model: resolved.model }
  if (resolved.effort) next.effort = resolved.effort
  else delete next.effort
  return next
}
