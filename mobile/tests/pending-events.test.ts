/** Verifies bounded retry queue invariants used by offline Android sync. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  appendPendingEvent,
  MAX_PENDING_EVENTS,
  removePendingEventFromQueue,
} from "../lib/pending-events.ts"
import type { MobilePendingEvent } from "../lib/contracts"

/** Creates a small passive event fixture without involving AsyncStorage. */
function event(id: string): MobilePendingEvent {
  return {
    eventId: id,
    projectId: "project",
    cardId: "card",
    type: "exposure",
    occurredAt: 1,
  }
}

test("appendPendingEvent bounds passive events", () => {
  const events = Array.from({ length: MAX_PENDING_EVENTS }, (_, index) =>
    event(String(index))
  )
  const next = appendPendingEvent(events, event("new"))

  assert.equal(next.length, MAX_PENDING_EVENTS)
  assert.equal(next[0]?.eventId, "1")
  assert.equal(next.at(-1)?.eventId, "new")
})

test("removePendingEventFromQueue preserves order and removes only the match", () => {
  const next = removePendingEventFromQueue(
    [event("a"), event("b"), event("c")],
    "b"
  )

  assert.deepEqual(
    next.map((item) => item.eventId),
    ["a", "c"]
  )
})


test("queue pressure never discards unsynced answers", () => {
  const answer = (id: string): MobilePendingEvent => ({ ...event(id), type: "answer", answer: true })
  const full = Array.from({length: MAX_PENDING_EVENTS}, (_, index) => answer(String(index)))
  assert.throws(() => appendPendingEvent(full, answer("new")), /Sync your saved answers/)
  assert.equal(full.length, MAX_PENDING_EVENTS)
  assert.equal(full[0]?.eventId, "0")
  assert.deepEqual(appendPendingEvent(full, event("passive")), full)
  const mixed = [answer("retained"), event("disposable"), ...full.slice(2)]
  const next = appendPendingEvent(mixed, answer("new"))
  assert.equal(next[0]?.eventId, "retained")
  assert.ok(!next.some((entry) => entry.eventId === "disposable"))
})
