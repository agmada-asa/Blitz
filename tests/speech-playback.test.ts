/** Verifies browser speech preparation, continuous scheduling, bounded buffering, and cancellation. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  playSpeechSections,
  prepareSpeechOpening,
} from "../lib/client/speech-playback.ts"

/** A controlled Web Audio source lets tests finish playback without waiting for real audio. */
class TestSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  startsAt = 0
  stopped = false
  disconnected = false
  /** Records the connection to the test output. */
  connect() {}
  /** Records release after completion or cancellation. */
  disconnect() {
    this.disconnected = true
  }
  /** Records the precise playback time instead of emitting sound. */
  start(at: number) {
    this.startsAt = at
  }
  /** Completes a stopped source using the same event as a natural ending. */
  stop() {
    this.stopped = true
    this.finish()
  }
  /** Completes this source at the test's chosen time. */
  finish() {
    const ended = this.onended
    this.onended = null
    ended?.()
  }
}

/** Minimal browser audio context that records resume and source scheduling. */
class TestContext {
  static instances: TestContext[] = []
  state = "suspended"
  currentTime = 0
  destination = {}
  sources: TestSource[] = []
  resumed = false
  /** Tracks each constructed context so tests can inspect scheduling. */
  constructor() {
    TestContext.instances.push(this)
  }
  /** Unlocks audio synchronously to model the click's user activation. */
  async resume() {
    this.resumed = true
    this.state = "running"
  }
  /** Decodes fixture bytes as a two-second section. */
  async decodeAudioData() {
    return { duration: 2 }
  }
  /** Records one prepared source. */
  createBufferSource() {
    const source = new TestSource()
    this.sources.push(source)
    return source
  }
}

/** Waits for asynchronous fetching/decoding to reach an observable state, with a bounded timeout. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail("Speech did not reach the expected state")
}

test("speech player prepares openings, buffers continuously, and releases cancelled audio", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        text: string
        voiceId: string
        preparation: boolean
      }
      requests.push(body)
      return new Response(new Uint8Array([1, 2, 3, 4]))
    }
  )
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = TestContext as unknown as typeof AudioContext
  const requests: Array<{
    text: string
    voiceId: string
    preparation: boolean
  }> = []
  try {
    const release = prepareSpeechOpening("Prepared opening.", "af_heart")
    await until(() => requests.length === 1)
    // Allow the full Response body and preparation bookkeeping to finish.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const controller = new AbortController()
    const playing = playSpeechSections(
      ["Prepared opening.", "Second section.", "Third section."],
      "af_heart",
      controller.signal,
      () => {}
    )
    const rejected = assert.rejects(playing, { name: "AbortError" })
    const context = TestContext.instances.at(-1)!
    assert.equal(
      context.resumed,
      true,
      "Audio resumes before an async boundary"
    )
    await until(() => context.sources.length === 2)
    assert.equal(
      requests.length,
      2,
      "Prepared opening avoids another request and lookahead stays bounded"
    )
    assert.equal(
      context.sources[1].startsAt,
      context.sources[0].startsAt + 2,
      "Sections join without a browser scheduling gap"
    )
    context.currentTime = 2
    context.sources[0].finish()
    await until(() => context.sources.length === 3)
    controller.abort()
    await rejected
    assert.ok(
      context.sources
        .slice(1)
        .every((source) => source.stopped && source.disconnected)
    )
    release()

    const changedVoice = new AbortController()
    const replay = playSpeechSections(
      ["Prepared opening."],
      "am_michael",
      changedVoice.signal,
      () => {}
    )
    await until(
      () =>
        requests.at(-1)?.voiceId === "am_michael" &&
        context.sources.length === 4
    )
    context.sources.at(-1)!.finish()
    await replay
    assert.equal(requests[0].preparation, true)
    assert.equal(requests.at(-1)?.preparation, false)

    context.state = "closed"
    const blockedResume = t.mock.method(
      TestContext.prototype,
      "resume",
      () => new Promise<void>(() => {})
    )
    const blocked = new AbortController()
    const waiting = playSpeechSections(
      ["Audio permission fixture."],
      "af_heart",
      blocked.signal,
      () => {}
    )
    blocked.abort()
    await assert.rejects(waiting, { name: "AbortError" })
    blockedResume.mock.restore()

    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        { error: "Voice could not be generated. Try again." },
        { status: 503 }
      )
    )
    await assert.rejects(
      playSpeechSections(
        ["Uncached failure."],
        "af_heart",
        new AbortController().signal,
        () => {}
      ),
      /Voice could not be generated/
    )
  } finally {
    globalThis.AudioContext = originalContext
  }
})
