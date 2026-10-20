/** Verifies local day keys, XP streaks, and the recap parsing that feeds the Review feed. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  comboBonus,
  computeStreak,
  scoreAnswers,
  localDayKey,
  previousDayKey,
  summarizeSession,
  XP,
} from "../lib/progress.ts"
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

test("any study keeps the streak and an unfinished today does not break it", () => {
  const xp = new Map([
    ["2026-10-07", 60],
    ["2026-10-08", 5],
    ["2026-10-09", 80],
  ])
  const before = computeStreak(xp, "2026-10-10", 50)
  assert.equal(before.current, 3)
  assert.equal(before.todayMet, false)
  assert.equal(before.todayStudied, false)
  xp.set("2026-10-10", 20)
  const after = computeStreak(xp, "2026-10-10", 50)
  assert.equal(after.current, 4)
  assert.equal(after.todayStudied, true)
  assert.equal(after.todayMet, false)
  assert.equal(after.longest, 4)
})

test("a missed day resets the streak unless a freeze covers it", () => {
  const xp = new Map([
    ["2026-10-01", 50],
    ["2026-10-02", 50],
    ["2026-10-03", 50],
    ["2026-10-05", 70],
  ])
  const broken = computeStreak(xp, "2026-10-06", 50)
  assert.equal(broken.current, 1)
  assert.equal(broken.longest, 3)
  assert.equal(broken.freezes, 0)
  assert.equal(computeStreak(new Map(), "2026-10-06", 50).current, 0)

  // Seven study days earn a freeze, which covers the gap on the 8th.
  const week = new Map<string, number>()
  for (let day = 1; day <= 7; day++) week.set(`2026-10-0${day}`, 10)
  week.set("2026-10-09", 10)
  const frozen = computeStreak(week, "2026-10-10", 50)
  assert.equal(frozen.current, 8)
  assert.deepEqual(frozen.frozenDays, ["2026-10-08"])
  assert.equal(frozen.freezes, 0)
})

test("runs of right answers earn a capped combo bonus", () => {
  assert.equal(comboBonus(2), 0)
  assert.equal(comboBonus(3), 2)
  assert.equal(comboBonus(4), 4)
  assert.equal(comboBonus(20), 10)
  const minute = 60_000
  const scored = scoreAnswers([
    { occurredAt: 4 * minute, correct: true },
    { occurredAt: 1 * minute, correct: true },
    { occurredAt: 2 * minute, correct: true },
    { occurredAt: 3 * minute, correct: false },
    { occurredAt: 5 * minute, correct: true },
    { occurredAt: 6 * minute, correct: true },
    // A long gap starts a new run.
    { occurredAt: 60 * minute, correct: true },
  ])
  assert.deepEqual(
    scored.map((entry) => entry.xp),
    [10, 10, 4, 10, 10, 12, 10]
  )
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

test("summarizes a session's answers, milestones, and concepts", () => {
  const totals = summarizeSession(
    [
      { conceptId: "heaps", correct: true },
      { conceptId: "sorting", correct: false },
      { conceptId: "heaps", correct: true },
      { conceptId: "sorting", correct: true },
      { conceptId: "graphs", correct: true },
    ],
    [{ kind: "section" }, { kind: "section" }, { kind: "unit" }]
  )
  assert.equal(totals.answered, 5)
  assert.equal(totals.correct, 4)
  assert.equal(totals.sections, 2)
  assert.equal(totals.unitsCompleted, 1)
  assert.equal(
    totals.xp,
    4 * XP.correctAnswer + XP.incorrectAnswer + 2 * XP.section + XP.unit
  )
  // Concepts with mistakes come first, then the most practised.
  assert.deepEqual(
    totals.concepts.map((concept) => [concept.conceptId, concept.correct, concept.answered]),
    [
      ["sorting", 1, 2],
      ["heaps", 2, 2],
      ["graphs", 1, 1],
    ]
  )
  assert.deepEqual(summarizeSession([], []), {
    answered: 0,
    correct: 0,
    xp: 0,
    sections: 0,
    unitsCompleted: 0,
    concepts: [],
    bestRun: 0,
  })
  // Timed answers earn the combo bonus: 10 + 10 + 12 + 14 + 16.
  const timed = summarizeSession(
    Array.from({ length: 5 }, (_, index) => ({
      conceptId: "heaps",
      correct: true,
      occurredAt: index * 60_000,
    })),
    []
  )
  assert.equal(timed.xp, 62)
  assert.equal(timed.bestRun, 5)
  // A run carried in from before the session keeps the XP the day gave it.
  const carried = summarizeSession(
    [
      { conceptId: "heaps", correct: true, occurredAt: 0, scored: { xp: 16, run: 5 } },
      { conceptId: "heaps", correct: false, occurredAt: 1, scored: { xp: 4, run: 0 } },
    ],
    []
  )
  assert.equal(carried.xp, 20)
  assert.equal(carried.bestRun, 5)
})
