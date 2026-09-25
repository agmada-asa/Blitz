/**
 * Provides persistent favorite models management stored in localStorage with cross-component reactivity.
 *
 * This hook allows learners to star and unstar AI models across chat and settings,
 * preserving quick access to their preferred models in the model picker's Favorites view.
 */

"use client"

import { useCallback, useEffect, useState } from "react"

/** Storage key used to persist the learner's favorited AI model identifiers. */
export const FAVORITE_MODELS_STORAGE_KEY = "blitz_favorite_models"

/** Custom event fired to synchronize favorite state across pickers on the same page. */
const FAVORITE_MODELS_EVENT = "blitz:favorite-models-change"

/** Curated default models starred before the learner customizes their list. */
export const DEFAULT_FAVORITE_MODELS: readonly string[] = [
  "gpt-6-astra",
  "gpt-6-luna",
]

/**
 * Safely reads the favorite model IDs from browser storage, falling back to defaults.
 *
 * @returns An array of unique favorited model ID strings.
 */
function readStoredFavorites(): string[] {
  if (typeof window === "undefined") return [...DEFAULT_FAVORITE_MODELS]
  try {
    const raw = window.localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)
    if (!raw) return [...DEFAULT_FAVORITE_MODELS]
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return parsed
    }
    return [...DEFAULT_FAVORITE_MODELS]
  } catch {
    return [...DEFAULT_FAVORITE_MODELS]
  }
}

/**
 * Writes the favorite model list to localStorage and broadcasts the change locally.
 *
 * @param favorites - The updated collection of favorited model IDs.
 */
function writeStoredFavorites(favorites: string[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      FAVORITE_MODELS_STORAGE_KEY,
      JSON.stringify(favorites)
    )
    window.dispatchEvent(
      new CustomEvent(FAVORITE_MODELS_EVENT, { detail: favorites })
    )
  } catch {
    // Gracefully ignore local storage quota or privacy restrictions
  }
}

/**
 * React hook that exposes favorite models and provides toggle capabilities with cross-component sync.
 *
 * @returns The list of favorite model IDs, helper check function, and toggle action.
 */
export function useFavoriteModels() {
  const [favorites, setFavorites] = useState<string[]>(readStoredFavorites)

  useEffect(() => {
    /** Refreshes local component state when another picker updates favorites. */
    const handleLocalChange = (event: Event) => {
      const customEvent = event as CustomEvent<string[]>
      if (Array.isArray(customEvent.detail)) {
        setFavorites(customEvent.detail)
      } else {
        setFavorites(readStoredFavorites())
      }
    }

    /** Synchronizes state when another browser tab modifies the storage key. */
    const handleStorage = (event: StorageEvent) => {
      if (event.key === FAVORITE_MODELS_STORAGE_KEY) {
        setFavorites(readStoredFavorites())
      }
    }

    window.addEventListener(FAVORITE_MODELS_EVENT, handleLocalChange)
    window.addEventListener("storage", handleStorage)

    return () => {
      window.removeEventListener(FAVORITE_MODELS_EVENT, handleLocalChange)
      window.removeEventListener("storage", handleStorage)
    }
  }, [])

  /** Returns whether a given model ID is in the user's favorites list. */
  const isFavorite = useCallback(
    (modelId: string): boolean => favorites.includes(modelId),
    [favorites]
  )

  /** Toggles the favorite status of a model ID, updating storage and notifying other pickers. */
  const toggleFavorite = useCallback(
    (modelId: string): void => {
      const next = favorites.includes(modelId)
        ? favorites.filter((id) => id !== modelId)
        : [...favorites, modelId]
      setFavorites(next)
      writeStoredFavorites(next)
    },
    [favorites]
  )

  return {
    favorites,
    isFavorite,
    toggleFavorite,
  }
}
