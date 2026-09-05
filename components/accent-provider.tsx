"use client"

/** Persists the selected Blitz accent and exposes it to the settings controls. */

import * as React from "react"

/** A selectable accent from the ROYGBIV palette. */
export const ACCENT_OPTIONS = [
  { id: "red", label: "Red", swatch: "#ef4444", swatchForeground: "#ffffff" },
  {
    id: "orange",
    label: "Orange",
    swatch: "#f97316",
    swatchForeground: "#ffffff",
  },
  {
    id: "yellow",
    label: "Yellow",
    swatch: "#eab308",
    swatchForeground: "#422006",
  },
  {
    id: "green",
    label: "Green",
    swatch: "#22c55e",
    swatchForeground: "#052e16",
  },
  {
    id: "blue",
    label: "Blue",
    swatch: "#3b82f6",
    swatchForeground: "#ffffff",
  },
  {
    id: "indigo",
    label: "Indigo",
    swatch: "#6366f1",
    swatchForeground: "#ffffff",
  },
  {
    id: "violet",
    label: "Violet",
    swatch: "#8b5cf6",
    swatchForeground: "#ffffff",
  },
] as const

/** Identifies one supported accent option. */
export type AccentColor = (typeof ACCENT_OPTIONS)[number]["id"]

/** Local-storage key used for the appearance preference. */
const ACCENT_STORAGE_KEY = "blitz-accent"

/** Accent used for first-time visitors and the server-rendered shell. */
const DEFAULT_ACCENT: AccentColor = "orange"

/** Listener collection used to notify settings controls of accent changes. */
const accentListeners = new Set<() => void>()

/** Client-side cache prevents repeated local-storage reads during a render. */
let clientAccent: AccentColor | undefined

/** Values shared between the global provider and the settings picker. */
type AccentContextValue = {
  accent: AccentColor
  setAccent: (accent: AccentColor) => void
}

const AccentContext = React.createContext<AccentContextValue | null>(null)

/** Validates a local-storage value before using it as a CSS data attribute. */
function isAccentColor(value: string | null): value is AccentColor {
  return ACCENT_OPTIONS.some((option) => option.id === value)
}

/** Reads a saved accent while allowing browsers that block local storage. */
function readStoredAccent(): AccentColor {
  try {
    const storedAccent = window.localStorage.getItem(ACCENT_STORAGE_KEY)
    return isAccentColor(storedAccent) ? storedAccent : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

/** Reads the browser accent snapshot for useSyncExternalStore. */
function getClientAccent(): AccentColor {
  clientAccent ??= readStoredAccent()
  return clientAccent
}

/** Supplies the stable accent used while the server renders the application. */
function getServerAccent(): AccentColor {
  return DEFAULT_ACCENT
}

/** Subscribes a settings control to accent changes in this browser tab. */
function subscribeToAccent(listener: () => void): () => void {
  accentListeners.add(listener)
  return () => accentListeners.delete(listener)
}

/** Applies the selected accent to the root element for the global token rules. */
function applyAccent(accent: AccentColor): void {
  document.documentElement.dataset.accent = accent
}

/** Stores an accent, updates the document, and notifies subscribed controls. */
function updateStoredAccent(nextAccent: AccentColor): void {
  clientAccent = nextAccent
  applyAccent(nextAccent)
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, nextAccent)
  } catch {
    // The in-memory selection still works when browser storage is unavailable.
  }
  accentListeners.forEach((listener) => listener())
}

/** Provides persisted accent state to the settings UI and the rest of Blitz. */
export function AccentProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const accent = React.useSyncExternalStore(
    subscribeToAccent,
    getClientAccent,
    getServerAccent
  )

  React.useEffect(() => {
    applyAccent(getClientAccent())

    /** Keeps another open Blitz tab in sync when it changes the accent. */
    function onStorageChange(event: StorageEvent): void {
      if (event.key !== ACCENT_STORAGE_KEY) return
      const nextAccent = isAccentColor(event.newValue)
        ? event.newValue
        : DEFAULT_ACCENT
      clientAccent = nextAccent
      applyAccent(nextAccent)
      accentListeners.forEach((listener) => listener())
    }

    window.addEventListener("storage", onStorageChange)
    return () => window.removeEventListener("storage", onStorageChange)
  }, [])

  const contextValue = React.useMemo(
    () => ({ accent, setAccent: updateStoredAccent }),
    [accent]
  )

  return (
    <AccentContext.Provider value={contextValue}>
      {children}
    </AccentContext.Provider>
  )
}

/** Returns the current accent controls and fails clearly outside its provider. */
export function useAccent(): AccentContextValue {
  const context = React.useContext(AccentContext)
  if (!context) {
    throw new Error("useAccent must be used inside AccentProvider")
  }
  return context
}
