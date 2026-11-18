/**
 * Checks how the MCP server reads weeks from unit titles and finds the gaps in
 * a module's weeks, which `read_module` reports to agents and the gaps strip
 * draws. These are plain functions, so no running app is needed.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { describeWeeks, gapsOf, weekOf } from "../mcp/blitz.mjs"

test("a week is read from the usual ways of writing it", () => {
  assert.equal(weekOf("Week 4: Normalisation"), 4)
  assert.equal(weekOf("week 09 - Functional C++"), 9)
  assert.equal(weekOf("Wk 3 SQL"), 3)
  assert.equal(weekOf("W8 NoSQL"), 8)
  assert.equal(weekOf("Unit 1: Database design"), null)
  assert.equal(weekOf("New 3 topics"), null)
})

test("gaps are weeks with no unit and weeks left behind", () => {
  const unit = (week: number | null, taught: number) => ({ week, taught })
  assert.deepEqual(
    gapsOf([
      unit(1, 0),
      unit(2, 0),
      unit(null, 33),
      unit(4, 100),
      unit(5, 100),
      unit(8, 100),
    ]),
    { first: 1, last: 8, missing: [3, 6, 7], untaught: [1, 2] }
  )
  // A week not taught yet after the latest taught one is just next, not a gap.
  assert.deepEqual(gapsOf([unit(1, 100), unit(2, 0)]), {
    first: 1,
    last: 2,
    missing: [],
    untaught: [],
  })
  assert.equal(gapsOf([unit(3, 0), unit(null, 0)]), null)
})

test("week lists read as runs", () => {
  assert.equal(describeWeeks([1, 2, 6, 7, 9]), "1–2, 6–7 and 9")
  assert.equal(describeWeeks([3]), "3")
  assert.equal(describeWeeks([]), "")
})
