/**
 * Regression tests for the local voice review fixes: no capture in a hidden tab, muting drops
 * in-flight transcripts, and stopping an empty dictation still answers.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { HIDDEN_START_MESSAGE, VoiceConnection, type VoiceEvent } from "../lib/client/voice-connection.ts"
import type { Mic } from "../lib/client/voice-mic.ts"
import { VoiceTurns, type VoiceTurnHost } from "../scripts/voice-turns.ts"

/** Page visibility and listeners standing in for `document`. */
class TestDocument {
  hidden = false
  private listeners = new Set<() => void>()
  /** Registers a visibility listener. */
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener) }
  /** Removes a visibility listener. */
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener) }
  /** Hides the page and notifies listeners, as a tab switch does. */
  hide() { this.hidden = true; for (const listener of [...this.listeners]) listener() }
  /** Number of registered listeners, to check close() releases them. */
  get count() { return this.listeners.size }
}

/** A voice socket that opens, accepts the start message and reports ready when the test says so. */
class TestSocket {
  static OPEN = 1
  static last: TestSocket | undefined
  readyState = 0
  bufferedAmount = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  /** Opens on the next tick, like a real socket. */
  constructor() {
    TestSocket.last = this
    setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0)
  }
  /** Records sent frames and messages. */
  send(value: unknown) { this.sent.push(value) }
  /** Closes and reports it once. */
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
  /** Delivers one server message. */
  deliver(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

/** Installs browser globals for one test and returns the fake page. */
function browser(t: { after(fn: () => void): void }): TestDocument {
  const page = new TestDocument()
  const saved = { window: globalThis.window, document: globalThis.document, WebSocket: globalThis.WebSocket }
  Object.assign(globalThis, { window: { isSecureContext: true }, document: page, WebSocket: TestSocket })
  const fetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ url: "ws://voice.test/voice" })
  t.after(() => { Object.assign(globalThis, saved); globalThis.fetch = fetch; TestSocket.last = undefined })
  return page
}

/** A microphone opener that records whether capture was requested and released. */
function recorder() {
  const state = { opened: 0, stopped: 0, heard: undefined as ((packet: Int16Array) => void) | undefined }
  const release: { resolve: (mic: Mic) => void } = { resolve: () => {} }
  const mic: Mic = { mute() {}, stop() { state.stopped++ } }
  return {
    state, mic, release,
    /** Opens at once. */
    open: async (heard: (packet: Int16Array) => void) => { state.opened++; state.heard = heard; return mic },
    /** Waits until the test grants permission. */
    slow: (heard: (packet: Int16Array) => void) => {
      state.opened++; state.heard = heard
      return new Promise<Mic>(resolve => { release.resolve = resolve })
    },
  }
}

/** Waits for queued timers and promise callbacks. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** Fails instead of hanging when a start never notices the hidden page. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("start did not settle")), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

test("a page hidden while models warm never opens the microphone", async t => {
  const page = browser(t)
  const mic = recorder()
  const events: VoiceEvent[] = []
  const connection = new VoiceConnection(event => events.push(event), mic.open)
  try {
    const started = connection.start("voice")
    await tick(); await tick()
    // Models are still warming: the server has not said ready.
    page.hide()
    await assert.rejects(within(started), { message: HIDDEN_START_MESSAGE })
    assert.equal(mic.state.opened, 0)
    assert.deepEqual(events.map(event => event.type), ["closed"])
    assert.equal(page.count, 0)
  } finally { connection.close() }
})

test("a page already hidden at start never contacts the service", async t => {
  const page = browser(t)
  page.hidden = true
  const mic = recorder()
  const connection = new VoiceConnection(() => {}, mic.open)
  await assert.rejects(connection.start("dictate"), { message: HIDDEN_START_MESSAGE })
  assert.equal(TestSocket.last, undefined)
  assert.equal(mic.state.opened, 0)
})

test("a permission grant that arrives after the page is hidden is released, and no packet is sent", async t => {
  const page = browser(t)
  const mic = recorder()
  const connection = new VoiceConnection(() => {}, mic.slow)
  try {
    const started = connection.start("voice")
    await tick(); await tick()
    TestSocket.last!.deliver({ type: "ready" })
    await tick()
    assert.equal(mic.state.opened, 1)
    page.hide()
    mic.release.resolve(mic.mic)
    await assert.rejects(within(started), { message: HIDDEN_START_MESSAGE })
    assert.equal(mic.state.stopped, 1)
    mic.state.heard?.(new Int16Array(512))
    assert.ok(TestSocket.last!.sent.every(value => typeof value === "string"))
  } finally { connection.close() }
})

test("a visible session streams packets and stops them when hidden", async t => {
  const page = browser(t)
  const mic = recorder()
  const connection = new VoiceConnection(() => {}, mic.open)
  const started = connection.start("voice")
  await tick(); await tick()
  TestSocket.last!.deliver({ type: "ready" })
  await started
  mic.state.heard?.(new Int16Array(512))
  assert.equal(TestSocket.last!.sent.filter(value => typeof value !== "string").length, 1)
  page.hide()
  assert.equal(mic.state.stopped, 1)
  mic.state.heard?.(new Int16Array(512))
  assert.equal(TestSocket.last!.sent.filter(value => typeof value !== "string").length, 1)
})

/** A turn host whose transcriptions finish only when the test resolves them. */
function host() {
  const sent: Array<{ type: string; text?: string; state?: string; message?: string }> = []
  const pending: Array<(text: string) => void> = []
  let closed = false
  const value: VoiceTurnHost = {
    transcribe: () => new Promise<string>(resolve => { pending.push(resolve) }),
    send: message => { sent.push(message as (typeof sent)[number]) },
    endTurn: () => {},
    log: () => {},
    fail: error => { sent.push({ type: "error", message: String(error) }) },
    closed: () => closed,
  }
  return { value, sent, pending, close: () => { closed = true } }
}

test("muting while a turn is transcribed drops that transcript", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value)
  turns.mode = "voice"
  turns.speech()
  turns.audio(Buffer.alloc(3200))
  const taken = turns.take()
  assert.equal(fake.pending.length, 1)
  turns.reset()
  // New audio is accepted straight away after unmuting.
  assert.equal(turns.transcribing, false)
  fake.pending[0]("words spoken before mute")
  await taken
  assert.equal(fake.sent.some(message => message.type === "user"), false)
  assert.equal(fake.sent.at(-1)?.state, "listening")
})

test("muting drops a speculative transcript started at a pause", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value)
  turns.mode = "voice"
  turns.speech()
  turns.audio(Buffer.alloc(3200))
  await new Promise(resolve => setTimeout(resolve, 110))
  turns.pause()
  assert.equal(fake.pending.length, 1)
  turns.reset()
  fake.pending[0]("stale early words")
  // A later turn transcribes its own audio, not the stale speculative result.
  turns.speech()
  turns.audio(Buffer.alloc(3200))
  const taken = turns.take()
  assert.equal(fake.pending.length, 2)
  fake.pending[1]("fresh words")
  await taken
  assert.deepEqual(fake.sent.filter(message => message.type === "user").map(message => message.text), ["fresh words"])
})

test("stopping dictation before the first audio packet still answers", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value)
  turns.mode = "dictate"
  await turns.take()
  assert.deepEqual(fake.sent, [{ type: "user", text: "" }])
  assert.equal(fake.pending.length, 0)
})

test("a dictation that closes before transcription finishes sends nothing", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value)
  turns.audio(Buffer.alloc(3200))
  const taken = turns.take()
  fake.close()
  fake.pending[0]("late words")
  await taken
  assert.equal(fake.sent.some(message => message.type === "user"), false)
})
