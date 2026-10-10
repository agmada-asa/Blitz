/**
 * Runs one background polling loop inside the shared Blitz worker process.
 *
 * `scripts/worker.ts` hosts several loops (source recovery and Deep Research)
 * in one Node process. Each loop goes through `runWorkerLoop`, which contains
 * a failing step: the error is reported, the loop waits with exponential
 * backoff, and it tries again. The other loops keep running, and the process
 * only exits when it is asked to stop. The process supervisor in
 * `electron/service-manager.mjs` still restarts the whole process if it
 * crashes outright.
 */

import { setTimeout as pause } from "node:timers/promises"

/** Waits `ms`, rejecting early when `signal` aborts. Injectable for tests. */
export type WorkerWait = (ms: number, signal: AbortSignal) => Promise<unknown>

/** Options for one supervised polling loop. */
export type WorkerLoopOptions = {
  /**
   * Performs one unit of work and resolves to how long to wait, in
   * milliseconds, before the next step. A rejection counts as a failure.
   */
  step: (signal: AbortSignal) => Promise<number>
  /**
   * Reports a failed step. `retryInMs` is the backoff before the next
   * attempt, or `null` when the loop is running once and will not retry.
   */
  onFailure: (error: unknown, retryInMs: number | null) => void
  /** Ends the loop after the current step or wait when aborted. */
  signal: AbortSignal
  /** Runs a single step and returns instead of polling. */
  once?: boolean
  /** First backoff after a failure. Defaults to 3 seconds. */
  baseDelayMs?: number
  /** Longest backoff between failed attempts. Defaults to 30 seconds. */
  maxDelayMs?: number
  /** Waits between steps; defaults to an abortable timer. */
  wait?: WorkerWait
}

/** Default abortable wait used outside tests. */
const abortableWait: WorkerWait = (ms, signal) =>
  pause(ms, undefined, { signal })

/**
 * Returns the backoff after `failures` consecutive failed steps: the base
 * delay doubled per failure and capped at `maxDelayMs`.
 */
export function workerBackoffDelay(
  failures: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs)
}

/**
 * Polls `step` until `signal` aborts, isolating failures to this loop.
 *
 * A successful step resets the backoff. A failed step is passed to
 * `onFailure` and retried after `workerBackoffDelay`. Failures after the
 * signal aborts are treated as shutdown, not reported.
 *
 * @returns `true` when the loop stopped cleanly or its single `once` step
 *   succeeded, `false` when the `once` step failed.
 */
export async function runWorkerLoop({
  step,
  onFailure,
  signal,
  once = false,
  baseDelayMs = 3_000,
  maxDelayMs = 30_000,
  wait = abortableWait,
}: WorkerLoopOptions): Promise<boolean> {
  let failures = 0
  while (!signal.aborted) {
    let delay: number
    try {
      delay = await step(signal)
      failures = 0
      if (once) return true
    } catch (error) {
      if (signal.aborted) break
      failures += 1
      const retryInMs = once
        ? null
        : workerBackoffDelay(failures, baseDelayMs, maxDelayMs)
      onFailure(error, retryInMs)
      if (retryInMs === null) return false
      delay = retryInMs
    }
    if (signal.aborted) break
    if (delay <= 0) continue
    try {
      await wait(delay, signal)
    } catch {
      // The only expected rejection is the abort that ends the loop.
      if (signal.aborted) break
    }
  }
  return true
}
