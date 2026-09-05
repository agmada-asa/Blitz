/** Defines agent access levels and provides local storage caching and change subscription for chat. */

import * as React from "react"

/** Supported runtime authority levels for chat agent sessions. */
export type ChatAgentAutonomy = "approval" | "project" | "full"

/** Browser storage key for caching the preferred agent access level. */
export const AGENT_AUTONOMY_STORAGE_KEY = "blitz-agent-access-level-v1"

/** Fallback legacy key checked when reading older cached access levels. */
export const LEGACY_AGENT_AUTONOMY_STORAGE_KEY = "blitz-agent-access-level"

/** Default runtime autonomy assigned when no saved or cached preference exists. */
export const DEFAULT_AGENT_AUTONOMY: ChatAgentAutonomy = "approval"

/** Minimal storage interface accepted by caching helpers for deterministic testing. */
export type AgentAutonomyStorage = Pick<Storage, "getItem" | "setItem">

/** Validates whether an unknown value is a supported agent autonomy level. */
export function isChatAgentAutonomy(value: unknown): value is ChatAgentAutonomy {
  return value === "approval" || value === "project" || value === "full"
}

/** Reads the cached agent access level from local storage with a safe fallback to approval. */
export function readCachedAgentAutonomy(
  storage?: AgentAutonomyStorage | null
): ChatAgentAutonomy {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== "undefined"
        ? window.localStorage
        : null
  if (!targetStorage) return DEFAULT_AGENT_AUTONOMY
  try {
    const stored =
      targetStorage.getItem(AGENT_AUTONOMY_STORAGE_KEY) ??
      targetStorage.getItem(LEGACY_AGENT_AUTONOMY_STORAGE_KEY)
    return isChatAgentAutonomy(stored) ? stored : DEFAULT_AGENT_AUTONOMY
  } catch {
    return DEFAULT_AGENT_AUTONOMY
  }
}

/** In-memory listener set for tab-local subscribers. */
const autonomyListeners = new Set<() => void>()

/** Triggers all active tab listeners after a storage update. */
function notifyAutonomyListeners(): void {
  autonomyListeners.forEach((listener) => listener())
}

/** Persists the preferred agent access level to local storage and alerts active listeners. */
export function writeCachedAgentAutonomy(
  autonomy: ChatAgentAutonomy,
  storage?: AgentAutonomyStorage | null
): void {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== "undefined"
        ? window.localStorage
        : null
  if (targetStorage) {
    try {
      targetStorage.setItem(AGENT_AUTONOMY_STORAGE_KEY, autonomy)
    } catch {
      // Storage unavailable or quota exceeded; in-memory notification still proceeds.
    }
  }
  notifyAutonomyListeners()
}

/** Subscribes a component to access-level updates across this tab and concurrent browser windows. */
export function subscribeToCachedAgentAutonomy(
  listener: () => void
): () => void {
  autonomyListeners.add(listener)

  /** Receives cross-window storage notifications for access level changes. */
  function onStorageChange(event: StorageEvent): void {
    if (
      event.key === AGENT_AUTONOMY_STORAGE_KEY ||
      event.key === LEGACY_AGENT_AUTONOMY_STORAGE_KEY
    ) {
      listener()
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorageChange)
  }

  return () => {
    autonomyListeners.delete(listener)
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorageChange)
    }
  }
}

/** Supplies the browser cached agent autonomy level for useSyncExternalStore. */
export function getClientCachedAgentAutonomy(): ChatAgentAutonomy {
  return readCachedAgentAutonomy()
}

/** Supplies the server snapshot for SSR hydration safety. */
export function getServerCachedAgentAutonomy(): ChatAgentAutonomy {
  return DEFAULT_AGENT_AUTONOMY
}

/** Hook returning the reactive cached agent access level from local storage. */
export function useCachedAgentAutonomy(): ChatAgentAutonomy {
  return React.useSyncExternalStore(
    subscribeToCachedAgentAutonomy,
    getClientCachedAgentAutonomy,
    getServerCachedAgentAutonomy
  )
}
