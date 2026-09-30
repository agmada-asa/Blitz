/** Exercises scheduling, shared consumers, cancellation, and recovery without model inference. */

import assert from "node:assert/strict"
import test from "node:test"
import { SpeechQueue } from "../lib/server/speech-queue.ts"

/** Creates an externally controlled barrier for one active model task. */
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("foreground playback outranks recording and preparation without overlapping inference", async () => {
  const queue = new SpeechQueue()
  const order: string[] = []
  const gate = barrier()
  const active = queue.enqueue("active", async () => {
    order.push("active")
    await gate.promise
  })
  await Promise.resolve()
  const preparation = queue.enqueue(
    "prepare",
    async () => {
      order.push("prepare")
    },
    { priority: "preparation" }
  )
  const recording = queue.enqueue("record", async () => {
    order.push("record")
  })
  const playback = queue.enqueue(
    "play",
    async () => {
      order.push("play")
    },
    { priority: "playback" }
  )
  assert.deepEqual(order, ["active"])
  gate.release()
  await Promise.all([active, preparation, recording, playback])
  assert.deepEqual(order, ["active", "play", "record", "prepare"])
})

test("joining preparation promotes it and cancelling one consumer preserves the other", async () => {
  const queue = new SpeechQueue()
  const gate = barrier()
  const active = queue.enqueue("active", async () => gate.promise)
  await Promise.resolve()
  const order: string[] = []
  const controller = new AbortController()
  const prepared = queue.enqueue(
    "same",
    async () => {
      order.push("same")
      return 42
    },
    { priority: "preparation", signal: controller.signal }
  )
  const rejected = assert.rejects(prepared, { name: "AbortError" })
  const recording = queue.enqueue("record", async () => {
    order.push("record")
  })
  const playing = queue.enqueue(
    "same",
    async () => {
      throw new Error("Must share synthesis")
    },
    { priority: "playback" }
  )
  controller.abort()
  gate.release()
  assert.equal(await playing, 42)
  await Promise.all([active, recording, rejected])
  assert.deepEqual(order, ["same", "record"])
})

test("cancelled pending speech never runs and a rejected task does not block later speech", async () => {
  const queue = new SpeechQueue()
  const controller = new AbortController()
  const obsolete = queue.enqueue(
    "obsolete",
    async () => {
      assert.fail("Cancelled synthesis ran")
    },
    { signal: controller.signal }
  )
  const aborted = assert.rejects(obsolete, { name: "AbortError" })
  controller.abort()
  const failed = queue.enqueue("failed", async () => {
    throw new Error("worker failed")
  })
  const rejected = assert.rejects(failed, /worker failed/)
  const next = queue.enqueue("next", async () => "recovered")
  assert.equal(await next, "recovered")
  await Promise.all([aborted, rejected])
})

test("active inference remains shared after its original consumer cancels", async () => {
  const queue = new SpeechQueue()
  const gate = barrier()
  const controller = new AbortController()
  let runs = 0
  const original = queue.enqueue(
    "same",
    async () => {
      runs += 1
      await gate.promise
      return "audio"
    },
    { signal: controller.signal }
  )
  const aborted = assert.rejects(original, { name: "AbortError" })
  await Promise.resolve()
  controller.abort()
  const joined = queue.enqueue("same", async () => {
    assert.fail("Duplicated running synthesis")
  })
  gate.release()
  assert.equal(await joined, "audio")
  await aborted
  assert.equal(runs, 1)
})
