/** Exercises growing reply playback with controlled synthesis and audio completion. */
import assert from "node:assert/strict"
import test from "node:test"
import { StreamingSpeech } from "../lib/client/streaming-speech.ts"

/** Finishes scheduled audio without a browser or physical output device. */
class TestSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  /** Accepts the player's output connection. */
  connect() {}
  /** Releases the player's output connection. */
  disconnect() {}
  /** Completes asynchronously so the player can install its bookkeeping. */
  start() { setTimeout(() => this.onended?.(), 1) }
  /** Releases a cancelled section immediately. */
  stop() { this.onended?.() }
}

/** Supplies the small Web Audio interface used by streaming playback. */
class TestContext {
  state = "running"
  currentTime = 0
  destination = {}
  /** Keeps fixture playback available without a user gesture. */
  async resume() {}
  /** Returns a short fixture section regardless of its encoded bytes. */
  async decodeAudioData() { return { duration: 0.001 } }
  /** Creates a cancellable fixture section. */
  createBufferSource() { return new TestSource() }
}

test("streaming speech accepts unread metadata edits and bounds synthesis requests", async t => {
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = TestContext as unknown as typeof AudioContext
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)).text)
    return new Response(new Uint8Array([1, 2]))
  })
  const errors: unknown[] = []
  try {
    const reader = new StreamingSpeech("af_heart", () => {}, error => errors.push(error))
    // A lesson title can be spoken while its unfinished section marker is still hidden.
    reader.update("Cell division\n\n```section\ncells", false)
    reader.update("Cell division\n\nMitosis makes two cells.", true)
    await reader.done()
    assert.equal(errors.length, 0)
    assert.equal(requests.join(" "), "Cell division. Mitosis makes two cells.")

    requests.length = 0
    const long = new StreamingSpeech("af_heart", () => {}, error => errors.push(error))
    long.update("Membrane transport ".repeat(800), true)
    await long.done()
    assert.equal(errors.length, 0)
    assert.ok(requests.length > 2)
    assert.ok(requests.every(text => text.length <= 360))
    assert.equal(long.heard().match(/Membrane transport/g)?.length, 800)
  } finally {
    globalThis.AudioContext = originalContext
  }
})
