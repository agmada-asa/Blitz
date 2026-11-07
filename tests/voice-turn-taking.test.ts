/**
 * Voice-mode turn taking: noise and Whisper's stock phrases never become turns or stop a reply,
 * a lone opener waits for the rest of the thought, and only real words interrupt.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { meaningful, opener, VoiceTurns, type VoiceTurnHost } from "../scripts/voice-turns.ts"
import { parseWorkspaceChatRequest } from "../lib/server/workspace-chat.ts"

/** A second of 16 kHz PCM16. */
const SECOND = 32000

/** A turn host whose transcriptions finish only when the test resolves them. */
function host() {
  const sent: Array<{ type: string; text?: string; state?: string }> = []
  const pending: Array<(text: string) => void> = []
  const value: VoiceTurnHost = {
    transcribe: () => new Promise<string>(resolve => { pending.push(resolve) }),
    send: message => { sent.push(message as (typeof sent)[number]) },
    endTurn: () => {},
    log: () => {},
    fail: () => {},
    closed: () => false,
  }
  return { value, sent, pending }
}

/** Lets awaited transcriptions run. */
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** The message types sent, in order. */
const types = (sent: ReturnType<typeof host>["sent"]) => sent.map(message => message.type)

/** Speaks a second of audio and ends the turn with [words] as its transcript. */
async function turn(turns: VoiceTurns, fake: ReturnType<typeof host>, words: string): Promise<void> {
  turns.speech()
  turns.audio(Buffer.alloc(SECOND))
  const taken = turns.take()
  fake.pending.at(-1)!(words)
  await taken
}

test("noise, punctuation and Whisper's stock phrases are not words", () => {
  for (const text of ["", "!", " ... ", "Thank you.", "you", "Thanks for watching!", "Bye."])
    assert.equal(meaningful(text), false, text)
  for (const text of ["Thank you, that makes sense.", "No", "What is BFS?", "2"])
    assert.equal(meaningful(text), true, text)
})

test("openers are fillers, but answers are not", () => {
  for (const text of ["Okay.", "Um, so", "Right, well", "Hmm"]) assert.equal(opener(text), true, text)
  for (const text of ["Yes.", "No", "Okay, what is a heuristic?", "So what?"]) assert.equal(opener(text), false, text)
})

test("a noise turn goes back to listening without interrupting or sending", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  await turn(turns, fake, "!")
  await turn(turns, fake, "Thank you.")
  assert.deepEqual(types(fake.sent), ["state", "state", "state", "state"])
  assert.deepEqual(fake.sent.map(message => message.state), ["thinking", "listening", "thinking", "listening"])
})

test("a real turn interrupts the reply before it is sent", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  await turn(turns, fake, "What is a heuristic?")
  assert.deepEqual(types(fake.sent), ["state", "interrupt", "user"])
})

test("only a caption with real words stops a reply", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  turns.speech()
  turns.audio(Buffer.alloc(SECOND))
  const noise = turns.caption()
  fake.pending[0]("you")
  await noise
  assert.deepEqual(types(fake.sent), [])
  const words = turns.caption()
  fake.pending[1]("Wait, can you")
  await words
  assert.deepEqual(types(fake.sent), ["interrupt", "caption"])
  // The turn's final words don't interrupt twice.
  const taken = turns.take()
  fake.pending[2]("Wait, can you repeat that?")
  await taken
  assert.deepEqual(types(fake.sent), ["interrupt", "caption", "state", "user"])
})

test("words that stopped the reply but came to nothing let it carry on; a held opener doesn't", async () => {
  for (const [last, expected] of [["you", ["interrupt", "caption", "state", "dropped", "state"]], ["Okay.", ["interrupt", "caption", "state", "state"]]] as const) {
    const fake = host()
    const turns = new VoiceTurns(fake.value, { captionMs: 60_000, openerMs: 60_000 })
    turns.mode = "voice"
    turns.speech()
    turns.audio(Buffer.alloc(SECOND))
    const caption = turns.caption()
    fake.pending[0]("Wait, so")
    await caption
    const taken = turns.take()
    fake.pending[1](last)
    await taken
    assert.deepEqual(types(fake.sent), expected, last)
    turns.reset()
  }
})

test("a lone opener joins the words that follow it", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000, openerMs: 50 })
  turns.mode = "voice"
  await turn(turns, fake, "Okay.")
  assert.equal(fake.sent.some(message => message.type === "user"), false)
  await turn(turns, fake, "What comes next?")
  await settle(80)
  assert.deepEqual(fake.sent.filter(message => message.type === "user").map(message => message.text), ["Okay. What comes next?"])
})

test("a lone opener is sent alone when nothing follows", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000, openerMs: 20 })
  turns.mode = "voice"
  await turn(turns, fake, "Okay.")
  await settle(50)
  assert.deepEqual(fake.sent.filter(message => message.type === "user").map(message => message.text), ["Okay."])
})

test("muting drops a held opener", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000, openerMs: 20 })
  turns.mode = "voice"
  await turn(turns, fake, "Um.")
  turns.reset()
  await settle(50)
  assert.equal(fake.sent.some(message => message.type === "user"), false)
})

test("a detector event that lags behind a taken turn doesn't hold an empty turn open", async () => {
  const fake = host()
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  turns.speech()
  turns.audio(Buffer.alloc(SECOND))
  const taken = turns.take()
  assert.equal(turns.speech(), false)
  fake.pending[0]("What is a heuristic?")
  await taken
  assert.equal(turns.active, false)
})

test("two minutes without a turn boundary ends the turn in conversation, not the session", async () => {
  const fake = host()
  let failed = false
  fake.value.fail = () => { failed = true }
  const turns = new VoiceTurns(fake.value, { captionMs: 60_000 })
  turns.mode = "voice"
  turns.speech()
  for (let second = 0; second <= 120; second++) assert.equal(turns.audio(Buffer.alloc(SECOND)), true)
  assert.equal(failed, false)
  assert.equal(turns.transcribing, true)
  fake.pending.at(-1)!("And that is everything I wanted to say.")
  await settle()
  assert.deepEqual(types(fake.sent), ["state", "interrupt", "user"])
})

test("a voice note reaches the model only with a spoken turn", () => {
  const base = { message: "Why?", clientMessageId: "voice-note-test", projectIds: [], attachments: [] }
  const spoken = parseWorkspaceChatRequest({ ...base, spoken: true, voiceNote: "They heard only the first line." })
  assert.equal(spoken.voiceNote, "They heard only the first line.")
  assert.equal(parseWorkspaceChatRequest({ ...base, voiceNote: "ignored" }).voiceNote, undefined)
  assert.throws(() => parseWorkspaceChatRequest({ ...base, spoken: true, voiceNote: "x".repeat(2_501) }), /Voice note/)
})
