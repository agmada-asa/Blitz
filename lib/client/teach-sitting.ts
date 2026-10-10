/**
 * Remembers when the learner sat down with a unit's Teach session, so the
 * "Finish for now" summary covers this sitting even across reloads. A sitting
 * ends after a long gap, and the next visit starts a new one.
 */

/** A gap longer than this starts a new sitting. */
export const SITTING_GAP_MS = 3 * 60 * 60 * 1000

/** Storage key for one unit's sitting. */
function key(unitId: string): string {
  return `blitz:teach-sitting:${unitId}`
}

/**
 * Returns when the current sitting started, starting one now if there is
 * none or the last one went quiet. Each call also marks the sitting active.
 * @param unitId Unit being taught.
 * @param now Current time in milliseconds.
 * @returns The sitting's start time; `now` when storage is unavailable.
 */
export function sittingStart(unitId: string, now: number): number {
  try {
    const saved = JSON.parse(
      window.sessionStorage.getItem(key(unitId)) ?? "null"
    ) as {
      start?: unknown
      seen?: unknown
    } | null
    const start =
      saved &&
      typeof saved.start === "number" &&
      typeof saved.seen === "number" &&
      now - saved.seen < SITTING_GAP_MS
        ? saved.start
        : now
    window.sessionStorage.setItem(
      key(unitId),
      JSON.stringify({ start, seen: now })
    )
    return start
  } catch {
    return now
  }
}

/**
 * Starts a new sitting, for when the learner finishes for now and keeps going later.
 * @param unitId Unit being taught.
 * @param now Current time in milliseconds.
 */
export function restartSitting(unitId: string, now: number): void {
  try {
    window.sessionStorage.setItem(
      key(unitId),
      JSON.stringify({ start: now, seen: now })
    )
  } catch {
    // Without storage the sitting simply starts at the next page load.
  }
}
