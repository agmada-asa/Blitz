/** Verifies streaming framing, cancellation, reconnects, and coalesced worker persistence. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as pause } from "node:timers/promises"
import { readChatStream, watchChatStream } from "../lib/chat-stream.ts"
import { createChatProgress } from "../lib/server/chat-progress.ts"

/** Produces a byte stream with arbitrary network packet boundaries. */
function bytes(text: string, size = 1) {
  const data = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < data.length; i += size)
        controller.enqueue(data.slice(i, i + size))
      controller.close()
    },
  })
}

test("stream decodes split Unicode, newlines, and heartbeat packets", async () => {
  const snapshots: unknown[] = []
  await readChatStream(
    bytes('\n{"reply":"café 🧠\\nnext"}\n{"reply":"done"}\n'),
    (value) => snapshots.push(value)
  )
  assert.deepEqual(snapshots, [{ reply: "café 🧠\nnext" }, { reply: "done" }])
  await assert.rejects(
    readChatStream(bytes('{"reply":"cut'), () => {}),
    /interrupted/
  )
})

test("reconnect restores a newer snapshot and closing stops further requests", async () => {
  const controller = new AbortController()
  const snapshots: unknown[] = []
  let requests = 0
  await watchChatStream("https://example.test/chat", {
    signal: controller.signal,
    fetcher: async () => {
      requests++
      return new Response(
        bytes(
          JSON.stringify({ reply: requests === 1 ? "partial" : "complete" }) +
            "\n"
        )
      )
    },
    onSnapshot: (value) => {
      snapshots.push(value)
      if (snapshots.length === 2) controller.abort()
    },
    onError: () => assert.fail("normal stream rollover is not an error"),
  })
  assert.equal(requests, 2)
  assert.deepEqual(snapshots, [{ reply: "partial" }, { reply: "complete" }])
})

test("progress appears before completion, coalesces slow writes, and drains before terminal persistence", async () => {
  const saved: string[] = []
  let release: (() => void) | undefined
  const writer = createChatProgress(async (reply) => {
    saved.push(reply)
    if (saved.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
  })
  writer.append("First")
  await pause(300)
  assert.deepEqual(saved, ["First"])
  for (let i = 0; i < 30; i++) writer.append(".")
  await pause(300)
  assert.equal(saved.length, 1)
  const finished = writer.finish()
  release?.()
  await finished
  assert.deepEqual(saved, ["First", "First" + ".".repeat(30)])
  writer.append("ignored")
  await pause(300)
  assert.equal(saved.length, 2)
})

test("failed progress writes do not prevent final persistence", async () => {
  const writer = createChatProgress(async () => {
    throw new Error("offline")
  })
  writer.append("retained by completion")
  await writer.finish()
})
