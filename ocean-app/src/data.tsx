/**
 * @file ocean-app/src/data.tsx
 * @description Data and navigation for the mini app: a hook that calls a Blitz tool and calls it
 * again whenever Ocean says something changed (the user here, or an agent adding material in an
 * Ocean chat), hash-based routes, and the shapes the `app_*` tools return (see `mcp/ocean.mjs`).
 */

import * as React from "react"
import { callTool, onNotification } from "./bridge"

/** Counts the changes Ocean has announced, so data hooks know to read again. */
const ChangesContext = React.createContext(0)

/**
 * Provides the change count to every screen, bumping it on each `ocean/changed` notification.
 *
 * @param props.children The app.
 */
export function ChangesProvider({ children }: { children: React.ReactNode }) {
  const [changes, setChanges] = React.useState(0)

  React.useEffect(
    () =>
      onNotification((method) => {
        if (method === "ocean/changed") setChanges((count) => count + 1)
      }),
    []
  )

  return (
    <ChangesContext.Provider value={changes}>
      {children}
    </ChangesContext.Provider>
  )
}

/** What a data hook holds: the last result, and whether a read is running or failed. */
export interface ToolState<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Reads again now. */
  reload: () => void
}

/**
 * Calls a tool and keeps its result, reading again when the arguments change, when Ocean
 * announces a change, or on `reload`. The previous result stays visible while a new read runs.
 *
 * @param name Tool name, or null to read nothing yet.
 * @param args Tool arguments; compared by value.
 * @returns The tool's state.
 */
export function useTool<T>(
  name: string | null,
  args: object = {}
): ToolState<T> {
  const changes = React.useContext(ChangesContext)
  const [attempt, setAttempt] = React.useState(0)
  const key = JSON.stringify(args)
  // Identifies one read; the hook is loading until the latest read has answered.
  const read = `${name}|${key}|${changes}|${attempt}`
  const [state, setState] = React.useState<{
    read: string | null
    data: T | null
    error: string | null
  }>({ read: null, data: null, error: null })

  React.useEffect(() => {
    if (!name) return
    let current = true
    callTool<T>(name, JSON.parse(key)).then(
      (data) => current && setState({ read, data, error: null }),
      (error: Error) =>
        current &&
        setState((previous) => ({ ...previous, read, error: error.message }))
    )
    return () => {
      current = false
    }
  }, [name, key, read])

  return {
    data: state.data,
    error: state.error,
    loading: Boolean(name) && state.read !== read,
    reload: () => setAttempt((count) => count + 1),
  }
}

/**
 * Follows the hash route, such as `#/module/<id>`.
 *
 * @returns The route's parts, decoded; `["today"]` when empty.
 */
export function useRoute(): string[] {
  const read = () => {
    const parts = window.location.hash
      .replace(/^#\/?/u, "")
      .split("/")
      .filter(Boolean)
    return parts.length
      ? parts.map((part) => decodeURIComponent(part))
      : ["today"]
  }
  const [route, setRoute] = React.useState(read)

  React.useEffect(() => {
    const changed = () => setRoute(read())
    window.addEventListener("hashchange", changed)
    return () => window.removeEventListener("hashchange", changed)
  }, [])

  return route
}

/**
 * Goes back a screen, or to Today when the app was opened straight onto this one (from a widget).
 */
export function back(): void {
  if (window.history.state?.blitzDepth) window.history.back()
  else go("today")
}

/**
 * Opens a route. Each entry records how deep it is in the app, so `back` knows whether there's a
 * screen of ours to return to.
 *
 * @param parts Route parts, encoded here; e.g. `go("module", id)`.
 */
export function go(...parts: string[]): void {
  const depth = (window.history.state?.blitzDepth ?? 0) + 1
  window.history.pushState(
    { blitzDepth: depth },
    "",
    `#/${parts.map((part) => encodeURIComponent(part)).join("/")}`
  )
  // pushState doesn't announce itself; useRoute listens for hashchange.
  window.dispatchEvent(new HashChangeEvent("hashchange"))
}

/** The lesson to continue, as `app_home` returns it. */
export interface Resume {
  module: string
  moduleTitle: string
  unit: string
  unitTitle: string
  detail: string
}

/** `app_home`: today's progress and the Library. */
export interface Home {
  /** Base address for links that open Blitz itself, reachable from the phone. */
  links: string
  today: {
    xp: number
    goal: number
    streak: number
    longest: number
    goalMet: boolean
    answered: number
    sections: number
    due: number
    week: Array<{ day: string; xp: number }>
    resume: Resume | null
  }
  modules: Array<{
    id: string
    title: string
    units: number
    finished: number
    next: string | null
    unsorted: boolean
    lastStudiedAt: number | null
    /** Share of the module taught, 0 to 1. */
    progress: number
  }>
}

/** One source in a module, as `app_module` returns it. */
export interface SourceItem {
  id: string
  name: string
  status: string
  unreadable: boolean
  error: string | null
}

/** `app_module`: one module's units, sources and practice summary. */
export interface ModuleDetail {
  id: string
  title: string
  links: string
  units: Array<{
    id: string
    title: string
    /** Whole percentage taught. */
    taught: number
    started: boolean
    section: string | null
    questions: number
    answered: number
    correct: number
    sources: SourceItem[]
  }>
  unsorted: SourceItem[]
  references: SourceItem[]
  practice: {
    due: number
    missed: number
    unanswered: number
    weak: Array<{ title: string; unit: string; accuracy: number | null }>
  }
}

/**
 * The address of a unit's Teach session in Blitz, which opens in the phone's browser.
 *
 * @param links Base address from `app_home` or `app_module`.
 * @param module Module id.
 * @param unit Unit id.
 * @returns The Teach page's URL.
 */
export function teachUrl(links: string, module: string, unit: string): string {
  return `${links}/projects/${module}/learn/${unit}`
}

/**
 * Makes an id for one answer or skip, so a retried call isn't counted twice.
 *
 * @returns A random id.
 */
export function eventId(): string {
  return `ocean-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
