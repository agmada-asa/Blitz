/**
 * Holds engines started ahead of a Teach session's first turn, so the turn
 * finds its runtime already running instead of starting one.
 *
 * Blitz normally creates an engine per turn and closes it afterwards. Opening
 * a unit's Teach screen offers one prewarmed engine here, keyed by provider,
 * folder, and launch settings; the first turn with the same key claims it and
 * owns it from then on, closing it like any other. An engine nobody claims
 * closes itself after `PREWARM_TTL_MS`, so no runtime outlives a visit for
 * long. The pool lives on `globalThis` so the prewarm and chat routes share
 * it within one server process, across hot reloads.
 */

import type { CodexEngineOptions, Engine } from "agent-engines"

/** How long an unclaimed prewarmed engine stays up before it is closed. */
export const PREWARM_TTL_MS = 3 * 60 * 1_000

/** Most prewarmed engines kept at once; the oldest is closed to make room. */
const MAX_PREWARMED_ENGINES = 4

/** How long closing an expired engine may take before it is left to exit. */
const CLOSE_TIMEOUT_MS = 1_000

/** Host tool handler a Codex engine forwards to once a turn claims it. */
export type ToolCallHandler = NonNullable<CodexEngineOptions["onToolCall"]>

/** One prewarmed engine waiting for its turn. */
type PooledEngine = {
  readonly engine: Engine
  /** Points the engine's host tools at the claiming turn's handler (Codex). */
  readonly bindToolCalls?: (handler: ToolCallHandler | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const POOL_KEY = Symbol.for("blitz.prewarmed-engines")
type GlobalWithPool = typeof globalThis & {
  [POOL_KEY]?: Map<string, PooledEngine>
}

/** Returns the process-wide pool, keyed by `prewarmedEngineKey`. */
function pool(): Map<string, PooledEngine> {
  const target = globalThis as GlobalWithPool
  return (target[POOL_KEY] ??= new Map())
}

/** Closes an engine within a short bound, ignoring its errors. */
function closeQuietly(engine: Engine): void {
  void Promise.race([
    engine.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ])
}

/**
 * The key a prewarmed engine is offered and claimed under. Engines launched
 * with different settings are never interchangeable.
 *
 * @param providerId - Blitz provider of the engine.
 * @param workspaceDirectory - Folder the turn's thread runs in.
 * @param effortSelected - Whether the turn sets an effort, which changes the
 *   Claude Code launch environment.
 */
export function prewarmedEngineKey(
  providerId: string,
  workspaceDirectory: string,
  effortSelected: boolean
): string {
  return JSON.stringify([providerId, workspaceDirectory, effortSelected])
}

/**
 * Offers a prewarmed engine for the next turn with the same key, replacing
 * and closing any engine already waiting under it.
 *
 * @param key - From `prewarmedEngineKey`.
 * @param engine - The engine, already starting its runtime.
 * @param bindToolCalls - For Codex, rebinds the engine's host tool handler.
 */
export function offerPrewarmedEngine(
  key: string,
  engine: Engine,
  bindToolCalls?: (handler: ToolCallHandler | undefined) => void
): void {
  const entries = pool()
  const existing = entries.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    entries.delete(key)
    closeQuietly(existing.engine)
  }
  while (entries.size >= MAX_PREWARMED_ENGINES) {
    const [oldestKey, oldest] = entries.entries().next().value!
    clearTimeout(oldest.timer)
    entries.delete(oldestKey)
    closeQuietly(oldest.engine)
  }
  const timer = setTimeout(() => {
    if (entries.get(key)?.engine !== engine) return
    entries.delete(key)
    closeQuietly(engine)
  }, PREWARM_TTL_MS)
  timer.unref?.()
  entries.set(key, { engine, ...(bindToolCalls ? { bindToolCalls } : {}), timer })
}

/**
 * Takes the engine waiting under `key`, if any. The caller owns it from then
 * on and must close it.
 */
export function claimPrewarmedEngine(
  key: string
): Pick<PooledEngine, "engine" | "bindToolCalls"> | undefined {
  const entries = pool()
  const entry = entries.get(key)
  if (!entry) return undefined
  clearTimeout(entry.timer)
  entries.delete(key)
  return { engine: entry.engine, ...(entry.bindToolCalls ? { bindToolCalls: entry.bindToolCalls } : {}) }
}

/** Drops an offered engine that failed to start, if it is still waiting. */
export function withdrawPrewarmedEngine(key: string, engine: Engine): void {
  const entries = pool()
  const entry = entries.get(key)
  if (entry?.engine !== engine) return
  clearTimeout(entry.timer)
  entries.delete(key)
  closeQuietly(engine)
}
