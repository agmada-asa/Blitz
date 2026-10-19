/** Verifies that worker loops back off on failure, recover, and stay isolated from each other. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  runWorkerLoop,
  workerBackoffDelay,
  type WorkerWait,
} from "../lib/server/worker-loop.ts"

/** Records requested waits and resolves them immediately. */
function recordingWait(): { waits: number[]; wait: WorkerWait } {
  const waits: number[] = []
  return {
    waits,
    wait: async (ms) => {
      waits.push(ms)
    },
  }
}

test("doubles the backoff per failure and caps it", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((failures) =>
      workerBackoffDelay(failures, 3_000, 30_000)
    ),
    [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]
  )
})

test("retries a failing step with backoff and resets after a success", async () => {
  const controller = new AbortController()
  const { waits, wait } = recordingWait()
  const outcomes = ["fail", "fail", "ok", "fail", "stop"]
  const failures: Array<number | null> = []
  const finished = await runWorkerLoop({
    signal: controller.signal,
    wait,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    onFailure: (_error, retryInMs) => failures.push(retryInMs),
    step: async () => {
      const outcome = outcomes.shift()
      if (outcome === "stop") controller.abort()
      if (outcome === "fail") throw new Error("Convex is down")
      return 50
    },
  })
  assert.equal(finished, true)
  assert.deepEqual(failures, [100, 200, 100])
  assert.deepEqual(waits, [100, 200, 50, 100])
})

test("does not report a failure caused by shutdown", async () => {
  const controller = new AbortController()
  const failures: unknown[] = []
  await runWorkerLoop({
    signal: controller.signal,
    wait: recordingWait().wait,
    onFailure: (error) => failures.push(error),
    step: async () => {
      controller.abort()
      throw new Error("aborted")
    },
  })
  assert.deepEqual(failures, [])
})

test("runs one step with once and reports whether it succeeded", async () => {
  const signal = new AbortController().signal
  const failures: Array<number | null> = []
  const succeeded = await runWorkerLoop({
    signal,
    once: true,
    onFailure: () => assert.fail("a successful step is not a failure"),
    step: async () => 1_000,
  })
  const failed = await runWorkerLoop({
    signal,
    once: true,
    onFailure: (_error, retryInMs) => failures.push(retryInMs),
    step: async () => {
      throw new Error("Research provider is unavailable")
    },
  })
  assert.equal(succeeded, true)
  assert.equal(failed, false)
  assert.deepEqual(failures, [null])
})

test("keeps one loop polling while another keeps failing", async () => {
  const controller = new AbortController()
  let healthySteps = 0
  let failingSteps = 0
  /** Yields to the event loop so both loops interleave like real timers. */
  const tick: WorkerWait = () => new Promise((resolve) => setImmediate(resolve))
  const healthy = runWorkerLoop({
    signal: controller.signal,
    wait: tick,
    onFailure: () => assert.fail("the healthy loop never fails"),
    step: async () => {
      healthySteps += 1
      if (healthySteps === 5) controller.abort()
      return 1
    },
  })
  const failing = runWorkerLoop({
    signal: controller.signal,
    wait: tick,
    onFailure: () => undefined,
    step: async () => {
      failingSteps += 1
      throw new Error("Research step crashed")
    },
  })
  assert.deepEqual(await Promise.all([healthy, failing]), [true, true])
  assert.equal(healthySteps, 5)
  assert.ok(failingSteps >= 3)
})
