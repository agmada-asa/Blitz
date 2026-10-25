/**
 * Verifies the spending caps for background tasks on an API-key sign-in:
 * their bounds, and that only a confirmed subscription runs uncapped. No
 * runtime is started; the sign-in check and saved caps are passed in.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_SPENDING_LIMITS,
  formatUsd,
  validateSpendingLimits,
} from "../lib/spending-limits.ts"
import { claudeBackgroundLimits } from "../lib/server/spending-limits.ts"

test("limits are bounded, whole-step, and rounded to cents", () => {
  assert.deepEqual(
    validateSpendingLimits({ maxTaskUsd: 2.499, maxTaskSteps: 12 }),
    {
      maxTaskUsd: 2.5,
      maxTaskSteps: 12,
    }
  )
  for (const bad of [
    { maxTaskUsd: 0, maxTaskSteps: 10 },
    { maxTaskUsd: 51, maxTaskSteps: 10 },
    { maxTaskUsd: Number.NaN, maxTaskSteps: 10 },
    { maxTaskUsd: "3", maxTaskSteps: 10 },
    { maxTaskUsd: 3, maxTaskSteps: 1 },
    { maxTaskUsd: 3, maxTaskSteps: 4.5 },
    { maxTaskUsd: 3, maxTaskSteps: 51 },
  ])
    assert.throws(
      () => validateSpendingLimits(bad),
      /Set a (task|step) limit between/
    )
  assert.doesNotThrow(() => validateSpendingLimits(DEFAULT_SPENDING_LIMITS))
  assert.equal(formatUsd(3), "$3.00")
})

test("only a confirmed subscription runs uncapped", async () => {
  const saved = async () => ({ maxTaskUsd: 1.5, maxTaskSteps: 8 })
  assert.equal(
    await claudeBackgroundLimits(async () => "subscription", saved),
    undefined
  )
  for (const billing of ["api-key", "unknown"] as const)
    assert.deepEqual(await claudeBackgroundLimits(async () => billing, saved), {
      maxBudgetUsd: 1.5,
      maxTurns: 8,
    })
  // A failed check or an unreadable record still caps, with the defaults.
  assert.deepEqual(
    await claudeBackgroundLimits(
      async () => {
        throw new Error("probe failed")
      },
      async () => {
        throw new Error("offline")
      }
    ),
    {
      maxBudgetUsd: DEFAULT_SPENDING_LIMITS.maxTaskUsd,
      maxTurns: DEFAULT_SPENDING_LIMITS.maxTaskSteps,
    }
  )
})
