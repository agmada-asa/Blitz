/** Discovers the authenticated Codex runtime model catalog without starting a turn. */

import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type CodexModel,
} from "../codex-app-server.ts"
import type { AiReasoningEffort } from "../../ai-model-settings.ts"
import type { ProviderModelOption } from "./types.ts"

const MAX_MODEL_PAGES = 20
const MODEL_PAGE_SIZE = 100
const MODEL_CACHE_TTL_MS = 30_000
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

type CodexModelCacheEntry = {
  readonly expiresAt: number
  readonly models: readonly ProviderModelOption[]
}

/** Normalizes a provider effort token while preserving newly added values. */
function normalizeReasoningEffort(value: string): AiReasoningEffort | undefined {
  const effort = value.trim().toLowerCase()
  return REASONING_EFFORT_PATTERN.test(effort)
    ? (effort as AiReasoningEffort)
    : undefined
}

const modelCache = new Map<string, CodexModelCacheEntry>()
const modelLoads = new Map<string, Promise<readonly ProviderModelOption[]>>()

/** Reads a bounded local model catalog cache key without including credentials. */
function cacheKey(options: CodexAppServerOptions): string {
  return `${options.executable ?? "codex"}\0${options.workspaceDirectory}`
}

/** Maps one native Codex model into the provider-neutral catalog shape. */
export function normalizeCodexModel(
  model: CodexModel
): ProviderModelOption | undefined {
  const id = model.model.trim() || model.id.trim()
  if (!id) return undefined
  const reasoningEfforts = model.supportedReasoningEfforts
    .map((option) => normalizeReasoningEffort(option.reasoningEffort))
    .filter((effort): effort is AiReasoningEffort => effort !== undefined)
  const uniqueReasoningEfforts = [...new Set(reasoningEfforts)]
  const fallbackReasoningEffort = model.defaultReasoningEffort
    ? (normalizeReasoningEffort(model.defaultReasoningEffort) ?? "default")
    : "default"
  return {
    id,
    label: model.displayName.trim() || id,
    ...(uniqueReasoningEfforts.length
      ? { reasoningEfforts: uniqueReasoningEfforts }
      : { reasoningEfforts: [fallbackReasoningEffort] }),
    inputModalities: model.inputModalities.filter(
      (modality): modality is "text" | "image" | "audio" =>
        modality === "text" || modality === "image" || modality === "audio"
    ),
    ...(model.isDefault ? { isDefault: true } : {}),
  }
}

/** Reads all visible pages from one authenticated Codex app-server connection. */
export async function listCodexModels(
  options: CodexAppServerOptions
): Promise<readonly ProviderModelOption[]> {
  const client = await CodexAppServerClient.connect(options)
  try {
    const models: ProviderModelOption[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response = await client.listModels({
        limit: MODEL_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const model of response.data) {
        if (model.hidden) continue
        const normalized = normalizeCodexModel(model)
        if (!normalized || seen.has(normalized.id)) continue
        seen.add(normalized.id)
        models.push(normalized)
      }
      if (!response.nextCursor) break
      cursor = response.nextCursor
    }
    return models
  } finally {
    await client.close()
  }
}

/** Returns a short-lived catalog snapshot so dispatch does not spawn per turn. */
export async function getCodexModelCatalog(
  options: CodexAppServerOptions
): Promise<readonly ProviderModelOption[]> {
  const key = cacheKey(options)
  const cached = modelCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.models
  const pending = modelLoads.get(key)
  if (pending) return pending
  const load = listCodexModels(options).then(
    (models) => {
      modelCache.set(key, {
        models,
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      })
      modelLoads.delete(key)
      return models
    },
    (error: unknown) => {
      modelLoads.delete(key)
      throw error
    }
  )
  modelLoads.set(key, load)
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
