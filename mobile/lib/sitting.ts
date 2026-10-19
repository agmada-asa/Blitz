/**
 * Remembers when the learner sat down with a unit on the phone, so "Finish
 * for now" summarises this sitting, as `lib/client/teach-sitting.ts` does on
 * desktop. A sitting ends after a three hour gap; the next visit starts a
 * new one.
 */

import AsyncStorage from "@react-native-async-storage/async-storage"

/** A gap longer than this starts a new sitting, matching desktop. */
export const SITTING_GAP_MS = 3 * 60 * 60 * 1000

/** Storage key for one unit's sitting. */
function key(unitId: string): string {
  return `@blitz/mobile/teach-sitting:${unitId}`
}

/**
 * Returns when the current sitting started, starting one now if there is
 * none or the last one went quiet, and marks it active.
 * @returns The sitting's start time; `now` when storage is unavailable.
 */
export async function sittingStart(unitId: string, now = Date.now()): Promise<number> {
  try {
    const saved = JSON.parse((await AsyncStorage.getItem(key(unitId))) ?? "null") as {
      start?: unknown
      seen?: unknown
    } | null
    const start =
      saved && typeof saved.start === "number" && typeof saved.seen === "number" && now - saved.seen < SITTING_GAP_MS
        ? saved.start
        : now
    await AsyncStorage.setItem(key(unitId), JSON.stringify({ start, seen: now }))
    return start
  } catch {
    return now
  }
}

/** Starts a new sitting after the learner finishes for now. */
export async function restartSitting(unitId: string, now = Date.now()): Promise<void> {
  await AsyncStorage.setItem(key(unitId), JSON.stringify({ start: now, seen: now })).catch(() => undefined)
}
