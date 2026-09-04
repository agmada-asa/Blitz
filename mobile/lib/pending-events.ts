/**
 * Provides pure queue operations for the native retry store. Keeping the cap
 * and removal rules framework independent makes event retention testable and
 * prevents concurrent storage writes from changing their ordering semantics.
 */

import type { MobilePendingEvent } from "./contracts"

/** Maximum pending events retained on one device. */
export const MAX_PENDING_EVENTS = 200

/** Appends without losing answer evidence; evicts passive events first or rejects a full answer queue. */
export function appendPendingEvent(
  events: readonly MobilePendingEvent[],
  event: MobilePendingEvent
): MobilePendingEvent[] {
  const next = [...events, event]
  while (next.length > MAX_PENDING_EVENTS) {
    const passiveIndex = next.findIndex((entry) => entry.type !== "answer")
    if (passiveIndex === -1) {
      throw new Error("Sync your saved answers before answering more cards.")
    }
    next.splice(passiveIndex, 1)
  }
  return next
}

/** Removes one delivered event while preserving every other event's order. */
export function removePendingEventFromQueue(
  events: readonly MobilePendingEvent[],
  eventId: string
): MobilePendingEvent[] {
  return events.filter((event) => event.eventId !== eventId)
}
