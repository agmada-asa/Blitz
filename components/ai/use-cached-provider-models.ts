/**
 * Exposes the last live provider model catalogs to the model picker.
 *
 * The server render and first client render both see no cached catalogs, so
 * hydration always matches; the cached catalogs apply immediately after, and
 * update whenever a picker saves a newer live response.
 */

"use client"

import { useSyncExternalStore } from "react"

import {
  getCachedProviderModels,
  getServerProviderModels,
  subscribeToProviderModels,
  type CachedProviderModels,
} from "@/lib/client/provider-model-cache"

/**
 * Returns the cached model catalogs keyed by provider.
 *
 * @returns Catalogs from the last live `/api/providers` response in this
 *   browser, or an empty object when none is cached or it has expired.
 */
export function useCachedProviderModels(): CachedProviderModels {
  return useSyncExternalStore(
    subscribeToProviderModels,
    getCachedProviderModels,
    getServerProviderModels
  )
}
