/** Verifies when the desktop app sends its daily study reminder and what it says. */

import assert from "node:assert/strict"
import test from "node:test"

import { reminderFor, startStudyReminders } from "../electron/reminders.mjs"

/** A summary with today's goal not met, overridable per test. */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    todayXp: 20,
    goal: 50,
    streak: { current: 4, todayMet: false },
    resume: { projectId: "p1", unitId: "u1", unitTitle: "Week 3: Graphs" },
    reminderHour: 19,
    ...overrides,
  }
}

test("reminds after the chosen hour when the goal is not met", () => {
  const reminder = reminderFor({
    now: new Date(2026, 9, 10, 19, 5),
    lastRemindedDay: undefined,
    summary: summary(),
  })
  assert.deepEqual(reminder, {
    day: "2026-10-10",
    title: "Keep your 4-day streak",
    body: "30 XP to go. Continue Week 3: Graphs.",
    path: "/projects/p1/learn/u1",
  })
})

test("stays quiet before the hour, once the goal is met, after reminding, or when off", () => {
  const evening = new Date(2026, 9, 10, 20, 0)
  assert.equal(reminderFor({ now: new Date(2026, 9, 10, 18, 59), lastRemindedDay: undefined, summary: summary() }), null)
  assert.equal(reminderFor({ now: evening, lastRemindedDay: undefined, summary: summary({ streak: { current: 4, todayMet: true } }) }), null)
  assert.equal(reminderFor({ now: evening, lastRemindedDay: "2026-10-10", summary: summary() }), null)
  assert.equal(reminderFor({ now: evening, lastRemindedDay: undefined, summary: summary({ reminderHour: null }) }), null)
})

test("without a unit in progress it points Home and invites a few questions", () => {
  const reminder = reminderFor({
    now: new Date(2026, 9, 10, 21, 0),
    lastRemindedDay: "2026-10-09",
    summary: summary({ resume: null, streak: { current: 0, todayMet: false }, todayXp: 0 }),
  })
  assert.equal(reminder?.title, "Time for today's study")
  assert.equal(reminder?.body, "50 XP to go. A few questions will do it.")
  assert.equal(reminder?.path, "/")
})

test("reminds once per day across repeated checks and survives load failures", async () => {
  const shown: string[] = []
  let calls = 0
  const stop = startStudyReminders({
    loadSummary: async () => {
      calls += 1
      if (calls === 1) throw new Error("Convex is starting")
      return summary()
    },
    notify: (reminder) => shown.push(reminder.title),
    intervalMs: 5,
    clock: () => new Date(2026, 9, 10, 20, 0),
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  stop()
  assert.ok(calls >= 3)
  assert.deepEqual(shown, ["Keep your 4-day streak"])
})
