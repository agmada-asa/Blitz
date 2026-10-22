/**
 * Reads the signed-in Codex model catalogue without starting a turn, and
 * checks a turn's model, effort, and image input against it.
 *
 * The catalogue comes from agent-engines (`CodexEngine.models()`); this module
 * keeps a short-lived snapshot so pickers and dispatch do not start an
 * app-server per request.
 */

import { createCodexEngine, providerModelOptions } from "./engines.ts"
import type { ProviderModelOption } from "./types.ts"

const MODEL_CACHE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

/** One cached catalogue and when it stops being reused. */
type CodexModelCacheEntry = {
  readonly expiresAt: number
  readonly models: readonly ProviderModelOption[]
}

let cached: CodexModelCacheEntry | undefined
let loading: Promise<readonly ProviderModelOption[]> | undefined

/**
 * Reads every visible model from one short-lived Codex app-server.
 *
 * @param options - Bound on how long the read may take.
 * @throws When Codex cannot start, is not signed in, or does not answer in time.
 */
export async function listCodexModels(
  options: { requestTimeoutMs?: number } = {}
): Promise<readonly ProviderModelOption[]> {
  const engine = createCodexEngine()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return providerModelOptions(
      await Promise.race([
        engine.models(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex did not list its models in time")),
            options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
          )
        }),
      ])
    )
  } finally {
    clearTimeout(timer)
    await engine.close().catch(() => undefined)
  }
}

/** Returns a short-lived catalogue snapshot so dispatch does not spawn per turn. */
export async function getCodexModelCatalog(
  options: { requestTimeoutMs?: number } = {}
): Promise<readonly ProviderModelOption[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.models
  if (loading) return loading
  const load = listCodexModels(options).then(
    (models) => {
      cached = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS }
      loading = undefined
      return models
    },
    (error: unknown) => {
      loading = undefined
      throw error
    }
  )
  loading = load
  return load
}

/** Validates a turn selection against the most recent native model catalog. */
export function validateCodexModelSelection(
  models: readonly ProviderModelOption[],
  selection: { model: string; effort?: string },
  requiresImage = false
): ProviderModelOption {
  const model = models.find((option) => option.id === selection.model)
  if (!model)
    throw new Error(`Codex model is not available: ${selection.model}`)
  if (
    selection.effort !== undefined &&
    !(model.reasoningEfforts ?? []).includes(selection.effort as never)
  )
    throw new Error(
      `Codex reasoning level is not available for ${selection.model}`
    )
  if (requiresImage && !model.inputModalities?.includes("image"))
    throw new Error(
      `Codex model does not support image input: ${selection.model}`
    )
  return model
}
