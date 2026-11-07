/**
 * Live captions and segmented dictation: words appear while the learner speaks, dictation commits
 * at detected turn ends and joins in order, and muting drops anything still being transcribed.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { VoiceTurns, type VoiceTurnHost } from "../scripts/voice-turns.ts"

/** A second of 16 kHz PCM16. */
const SECOND = 32000

/** A turn host whose transcriptions finish only when the test resolves them. */
function host() {
  const sent: Array<{ type: string; text?: string; state?: string; message?: string }> = []
  const pending: Array<{ resolve: (text: string) => void; context?: string; bytes: number }> = []
  let ended = 0
  const value: VoiceTurnHost = {
    transcribe: (pcm, context) => new Promise<string>(resolve => { pending.push({ resolve, context, bytes: pcm.length }) }),
    send: message => { sent.push(message as (typeof sent)[number]) },
    endTurn: () => { ended++ },
    log: () => {},
    fail: error => { sent.push({ type: "error", message: String(error) }) },
    closed: () => false,
  }
  return { value, sent, pending, ended: () => ended }
}

/** Lets awaited transcriptions and chained commits run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** Messages of one type, by text. */
const texts = (sent: ReturnType<typeof host>["sent"], type: string) =>
  sent.filter(message => message.type === type).map(message => message.text)

/** Speaks [seconds] of audio into a fresh segment. */
function speak(turns: VoiceTurns, seconds: number): void {
  turns.speech()
  turns.audio(Buffer.alloc(Math.round(seconds * SECOND)))
}

test("dictation commits each turn end and joins segments in order", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "dictate"
  speak(turns, 1)
  turns.commit()
  assert.equal(fake.ended(), 1)
  speak(turns, 1)
  turns.commit()
  assert.equal(fake.pending.length, 2)
  // The second segment finishes first, but segments are still joined in the order spoken.
  fake.pending[1].resolve("second part.")
  await settle()
  assert.deepEqual(texts(fake.sent, "caption"), [])
  fake.pending[0].resolve("First part,")
  await settle()
  assert.deepEqual(texts(fake.sent, "caption"), ["First part,", "First part, second part."])
  // Dictation never sends the learner's words until they stop.
  assert.deepEqual(texts(fake.sent, "user"), [])
  speak(turns, 1)
  turns.commit()
  assert.equal(fake.pending[2].context, "First part, second part.")
})

test("stopping waits for pending commits and returns the whole dictation", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "dictate"
  speak(turns, 1)
  turns.commit()
  speak(turns, 1)
  const stopped = turns.take()
  assert.equal(fake.pending.length, 2)
  fake.pending[1].resolve("and the rest")
  await settle()
  assert.deepEqual(texts(fake.sent, "user"), [])
  fake.pending[0].resolve("The start")
  await stopped
  assert.deepEqual(texts(fake.sent, "user"), ["The start and the rest"])
})

test("stopping after a commit skips a remainder with no speech", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "dictate"
  speak(turns, 1)
  turns.commit()
  turns.audio(Buffer.alloc(SECOND / 4))
  const stopped = turns.take()
  assert.equal(fake.pending.length, 1)
  fake.pending[0].resolve("Only this.")
  await stopped
  assert.deepEqual(texts(fake.sent, "user"), ["Only this."])
})

test("only one caption transcription runs at a time, and short audio gets none", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  speak(turns, 0.2)
  await turns.caption()
  assert.equal(fake.pending.length, 0)
  turns.audio(Buffer.alloc(SECOND))
  const first = turns.caption()
  void turns.caption()
  assert.equal(fake.pending.length, 1)
  fake.pending[0].resolve(" so if the load ")
  await first
  assert.deepEqual(texts(fake.sent, "caption"), ["so if the load"])
  void turns.caption()
  assert.equal(fake.pending.length, 2)
})

test("captions cover at most the last 20 seconds of a segment", () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  speak(turns, 24)
  void turns.caption()
  assert.equal(fake.pending[0].bytes, 20 * SECOND)
})

test("a caption for audio already taken as a turn is dropped", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  speak(turns, 1)
  const caption = turns.caption()
  const taken = turns.take()
  fake.pending[0].resolve("partial words")
  fake.pending[1].resolve("partial words and more")
  await Promise.all([caption, taken])
  assert.deepEqual(texts(fake.sent, "caption"), [])
  assert.deepEqual(texts(fake.sent, "user"), ["partial words and more"])
})

test("muting drops a pending caption and committed dictation", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "dictate"
  speak(turns, 1)
  turns.commit()
  speak(turns, 1)
  const caption = turns.caption()
  // No caption while a commit is still being transcribed.
  assert.equal(fake.pending.length, 1)
  fake.pending[0].resolve("before mute")
  await settle()
  void turns.caption()
  const late = fake.pending.length
  turns.reset()
  fake.pending.at(-1)!.resolve("stale caption")
  await caption
  await settle()
  assert.equal(late, 2)
  assert.deepEqual(texts(fake.sent, "caption"), ["before mute"])
  const stopped = turns.take()
  await stopped
  assert.deepEqual(texts(fake.sent, "user"), [""])
})

test("a dictation segment without a pause is committed at 25 seconds", () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "dictate"
  turns.speech()
  for (let second = 0; second < 25; second++) turns.audio(Buffer.alloc(SECOND))
  assert.equal(fake.pending.length, 1)
  assert.equal(fake.ended(), 1)
})

test("captions tick on their own while speech continues and stop at a pause", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 20 })
  turns.mode = "voice"
  speak(turns, 1)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(fake.pending.length, 1)
  fake.pending[0].resolve("hello")
  turns.pause()
  const count = fake.pending.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fake.pending.length, count)
  turns.clear()
})
