/**
 * Day headings and run collapsing for grouped lists: items land under Today, Yesterday,
 * This week or Earlier by local calendar day, keep their order, and only runs of two or more
 * neighbours with the same key collapse.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { collapseRuns, dayGroupLabel, groupByDay } from "../lib/day-groups.ts"

/** Builds a local timestamp so the tests hold in any time zone. */
function local(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour).getTime()
}

const NOW = local(2026, 11, 18, 9)

test("labels by local calendar day, not by 24 hour windows", () => {
  assert.equal(dayGroupLabel(local(2026, 11, 18, 0), NOW), "Today")
  assert.equal(dayGroupLabel(local(2026, 11, 17, 23), NOW), "Yesterday")
  assert.equal(dayGroupLabel(local(2026, 11, 17, 0), NOW), "Yesterday")
  assert.equal(dayGroupLabel(local(2026, 11, 16, 23), NOW), "This week")
  assert.equal(dayGroupLabel(local(2026, 11, 12, 0), NOW), "This week")
  assert.equal(dayGroupLabel(local(2026, 11, 11, 23), NOW), "Earlier")
  assert.equal(dayGroupLabel(NOW + 60_000, NOW), "Today")
})

test("groups keep item order and drop empty headings", () => {
  const items = [
    { id: "a", at: local(2026, 11, 18) },
    { id: "b", at: local(2026, 11, 18, 1) },
    { id: "c", at: local(2026, 11, 1) },
  ]
  const groups = groupByDay(items, (item) => item.at, NOW)
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.id)]),
    [
      ["Today", ["a", "b"]],
      ["Earlier", ["c"]],
    ]
  )
})

test("an out of order item joins its own group instead of repeating a heading", () => {
  const items = [
    { id: "pinned", at: local(2026, 10, 1) },
    { id: "new", at: local(2026, 11, 18) },
  ]
  const labels = groupByDay(items, (item) => item.at, NOW).map(
    (group) => group.label
  )
  assert.deepEqual(labels, ["Today", "Earlier"])
})

test("collapses only neighbouring runs of two or more with the same key", () => {
  const entries = collapseRuns(
    ["q1", "q2", "mark", "q3", "q4", "q5", "x"],
    (item) => (item.startsWith("q") ? "questions" : null)
  )
  assert.deepEqual(entries, [
    { type: "run", items: ["q1", "q2"] },
    { type: "single", item: "mark" },
    { type: "run", items: ["q3", "q4", "q5"] },
    { type: "single", item: "x" },
  ])
  assert.deepEqual(
    collapseRuns(["q1"], () => "questions"),
    [{ type: "single", item: "q1" }]
  )
})
