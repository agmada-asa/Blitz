"use client"

/**
 * Remembers the width a user dragged a side pane to, per browser, so a pane
 * reopens at the size they chose. Until a width is chosen (or after a reset)
 * the hook returns `null` and the pane keeps its stylesheet default.
 *
 * The saved width is only applied after hydration, so the server render and
 * the first client render match.
 */

import { useCallback, useState, useSyncExternalStore } from "react"

/** What `usePaneWidth` returns: the current width and ways to change it. */
export type PaneWidth = {
  /** Width in CSS pixels, or `null` to use the pane's default width. */
  width: number | null
  /** Shows a new width without saving it, for each step of a drag. */
  resize: (width: number) => void
  /** Saves the current or given width so the next visit opens at it. */
  save: (width?: number) => void
  /** Forgets the chosen width and returns to the default. */
  reset: () => void
}

/** Reads a saved width, returning `null` when none is stored or storage is blocked. */
function readWidth(storageKey: string): number | null {
  try {
    const saved = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved > 0 ? saved : null
  } catch {
    // Restricted contexts fall back to the default width.
    return null
  }
}

/**
 * Tracks a side pane's width and keeps it in `localStorage` under `storageKey`.
 * Storage errors are ignored: the pane still resizes, it just isn't remembered.
 */
export function usePaneWidth(storageKey: string): PaneWidth {
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  )
  const [width, setWidth] = useState<number | null>(() =>
    typeof window === "undefined" ? null : readWidth(storageKey)
  )

  const save = useCallback(
    (next?: number) => {
      const value = next ?? width
      if (value === null) return
      try {
        window.localStorage.setItem(storageKey, String(Math.round(value)))
      } catch {
        // The width still applies for this visit.
      }
    },
    [storageKey, width]
  )

  const reset = useCallback(() => {
    setWidth(null)
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      // Nothing saved to remove.
    }
  }, [storageKey])

  return { width: hydrated ? width : null, resize: setWidth, save, reset }
}
