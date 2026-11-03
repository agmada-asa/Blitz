/** Temporarily proves that an assertion failure fails the CI test job. */
import assert from "node:assert/strict"
import test from "node:test"

/** Deliberately fails until the verification probe is removed. */
function failProbe(): void {
  assert.fail("Intentional CI failure propagation probe")
}

test("CI fails when a test fails", failProbe)
