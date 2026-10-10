/** Verifies local day keys, XP streaks, and the recap parsing that feeds the home feed. */

import assert from "node:assert/strict"
import test from "node:test"

import { computeStreak, localDayKey, previousDayKey } from "../lib/progress.ts"
import { parseQuestionBank } from "../lib/practice.ts"

test("local day keys follow the learner's midnight", () => {
  const instant = Date.parse("2026-10-10T23:30:00Z")
  assert.equal(localDayKey(instant, 0), "2026-10-10")
  // UTC+1 (getTimezoneOffset = -60) is already the next day.
  assert.equal(localDayKey(instant, -60), "2026-10-11")
  // UTC-5 (getTimezoneOffset = 300) is still the same day.
  assert.equal(localDayKey(instant, 300), "2026-10-10")
})

test("previous day keys cross month and year boundaries", () => {
  assert.equal(previousDayKey("2026-03-01"), "2026-02-28")
  assert.equal(previousDayKey("2027-01-01", 2), "2026-12-30")
})

test("streaks count goal-met days and survive an unfinished today", () => {
  const xp = new Map([
    ["2026-10-07", 60],
    ["2026-10-08", 55],
    ["2026-10-09", 80],
    ["2026-10-10", 20],
  ])
  assert.deepEqual(computeStreak(xp, "2026-10-10", 50), {
    current: 3,
    todayMet: false,
    longest: 3,
  })
  xp.set("2026-10-10", 50)
  assert.deepEqual(computeStreak(xp, "2026-10-10", 50), {
    current: 4,
    todayMet: true,
    longest: 4,
  })
})

test("a missed day resets the current streak but not the longest", () => {
  const xp = new Map([
    ["2026-10-01", 50],
    ["2026-10-02", 50],
    ["2026-10-03", 50],
    ["2026-10-05", 70],
  ])
  assert.deepEqual(computeStreak(xp, "2026-10-06", 50), {
    current: 1,
    todayMet: false,
    longest: 3,
  })
  assert.equal(computeStreak(new Map(), "2026-10-06", 50).current, 0)
})

test("recaps are kept once per concept and malformed ones are dropped", () => {
  const parsed = parseQuestionBank(
    JSON.stringify({
      recaps: [
        { concept: "Recursion", title: "Recursion", body: "A function that calls itself on a smaller input until a base case." },
        { concept: "recursion", title: "Duplicate", body: "Should be dropped because the concept repeats." },
        { concept: "Short", title: "Too short", body: "Tiny." },
        { concept: "Missing body", title: "No body" },
      ],
      questions: [],
    })
  )
  assert.deepEqual(parsed.recaps.map((recap) => recap.title), ["Recursion"])
})
