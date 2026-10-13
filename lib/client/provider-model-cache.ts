/**
 * Remembers the last model catalogs the provider runtimes reported, in this
 * browser's local storage.
 *
 * The model picker asks `/api/providers` for live catalogs on every mount,
 * and that request takes a few seconds because it probes each runtime. Until
 * it returns, the picker would otherwise show Blitz's built-in model list,
 * which can lag behind the runtime. Showing the last live catalog instead
 * keeps names and reasoning levels accurate during that wait. Only model
 * metadata is stored; connection and account state always come from the
 * live request.
 */

import { isAiProviderId, type AiProviderId } from "../ai-model-settings.ts"
import type { ProviderModelOption } from "../server/providers/types.ts"

/** Local storage key for the cached catalogs. Bump the suffix when the shape changes. */
export const PROVIDER_MODEL_CACHE_KEY = "blitz_provider_models_v1"

/** Cached catalogs older than this are ignored; a month covers infrequent use. */
export const PROVIDER_MODEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Upper bound on cached models per provider, matching realistic catalogs. */
const MAX_CACHED_MODELS = 200

/** Last known model catalog for each provider that reported one. */
export type CachedProviderModels = Readonly<
  Partial<Record<AiProviderId, readonly ProviderModelOption[]>>
>

/** Stable empty value used on the server and when nothing valid is cached. */
export const EMPTY_PROVIDER_MODELS: CachedProviderModels = Object.freeze({})

/** Reads an object-like value without trusting its shape. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Returns the string entries of a value, or undefined when it is not an array. */
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined
}

/** Rebuilds one cached model from only the fields the picker uses. */
function parseModel(value: unknown): ProviderModelOption | undefined {
  const model = asObject(value)
  if (typeof model?.id !== "string" || !model.id) return undefined
  if (typeof model.label !== "string" || !model.label) return undefined
  const reasoningEfforts = strings(model.reasoningEfforts)
  const inputModalities = strings(model.inputModalities)?.filter(
    (modality): modality is "text" | "image" | "audio" =>
      modality === "text" || modality === "image" || modality === "audio"
  )
  return {
    id: model.id,
    label: model.label,
    ...(typeof model.reasoningEffort === "string"
      ? { reasoningEffort: model.reasoningEffort }
      : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(model.isDefault === true ? { isDefault: true } : {}),
  }
}

/**
 * Parses stored catalogs, discarding anything malformed, unknown, or stale.
 *
 * @param raw - The stored JSON string, or null when nothing is stored.
 * @param now - Current time, injectable for tests.
 * @returns Valid catalogs keyed by provider; empty when the value is missing,
 *   invalid, or older than {@link PROVIDER_MODEL_CACHE_MAX_AGE_MS}.
 */
export function parseCachedProviderModels(
  raw: string | null,
  now = Date.now()
): CachedProviderModels {
  if (!raw) return EMPTY_PROVIDER_MODELS
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return EMPTY_PROVIDER_MODELS
  }
  const cache = asObject(stored)
  const savedAt = cache?.savedAt
  const providers = asObject(cache?.providers)
  if (
    typeof savedAt !== "number" ||
    !providers ||
    now - savedAt > PROVIDER_MODEL_CACHE_MAX_AGE_MS
  )
    return EMPTY_PROVIDER_MODELS
  const result: Partial<Record<AiProviderId, readonly ProviderModelOption[]>> =
    {}
  for (const [providerId, models] of Object.entries(providers)) {
    if (!isAiProviderId(providerId) || !Array.isArray(models)) continue
    const parsed = models
      .slice(0, MAX_CACHED_MODELS)
      .map(parseModel)
      .filter((model): model is ProviderModelOption => model !== undefined)
    if (parsed.length) result[providerId] = parsed
  }
  return result
}

/**
 * Serializes the catalogs from one `/api/providers` response.
 *
 * @param availability - Providers as returned by the live request.
 * @param now - Save time, injectable for tests.
 * @returns JSON for local storage, or undefined when no provider reported
 *   models, so an empty response never overwrites a useful cache.
 */
export function serializeProviderModels(
  availability: readonly {
    readonly providerId: AiProviderId
    readonly models?: readonly ProviderModelOption[]
  }[],
  now = Date.now()
): string | undefined {
  const providers: Partial<
    Record<AiProviderId, readonly ProviderModelOption[]>
  > = {}
  for (const provider of availability)
    if (provider.models?.length)
      providers[provider.providerId] = provider.models.slice(
        0,
        MAX_CACHED_MODELS
      )
  if (!Object.keys(providers).length) return undefined
  return JSON.stringify({ savedAt: now, providers })
}

/** Parsed snapshot shared by every picker so renders read storage once. */
let snapshot: CachedProviderModels | undefined
/** Pickers subscribed to cache updates in this tab. */
const listeners = new Set<() => void>()

/** Returns the cached catalogs for `useSyncExternalStore` in the browser. */
export function getCachedProviderModels(): CachedProviderModels {
  if (snapshot) return snapshot
  try {
    snapshot = parseCachedProviderModels(
      window.localStorage.getItem(PROVIDER_MODEL_CACHE_KEY)
    )
  } catch {
    snapshot = EMPTY_PROVIDER_MODELS
  }
  return snapshot
}

/** Returns the empty server snapshot so hydration matches the server render. */
export function getServerProviderModels(): CachedProviderModels {
  return EMPTY_PROVIDER_MODELS
}

/**
 * Subscribes to cache updates from this tab and from other open Blitz tabs.
 *
 * @returns A function that removes the subscription.
 */
export function subscribeToProviderModels(listener: () => void): () => void {
  listeners.add(listener)
  /** Rereads the cache after another tab writes it. */
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== PROVIDER_MODEL_CACHE_KEY) return
    snapshot = undefined
    listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * Saves the catalogs from a live provider response and notifies pickers.
 * Storage failures are ignored; the picker then keeps the live data in memory.
 */
export function saveProviderModels(
  availability: Parameters<typeof serializeProviderModels>[0]
): void {
  const serialized = serializeProviderModels(availability)
  if (!serialized) return
  try {
    window.localStorage.setItem(PROVIDER_MODEL_CACHE_KEY, serialized)
  } catch {
    return
  }
  snapshot = parseCachedProviderModels(serialized)
  listeners.forEach((listener) => listener())
}
