/**
 * Turns a spoken Teach question into text on the Mac.
 *
 * A persistent Python worker (`scripts/speech-to-text-worker.py`) keeps an
 * on-device model loaded, in the same private environment and data folder as
 * Kokoro, so no paid service or network call is involved once the model is
 * downloaded. The browser records and encodes 16 kHz mono WAV; this module
 * checks it, hands it to the worker through a private temporary file, and
 * returns the transcript.
 */

import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { dataDirectory, pythonExecutable } from "./kokoro"
import { KokoroUnavailableError, KokoroWorker } from "./kokoro-worker"
import { SpeechQueue } from "./speech-queue"

/** Longest recording accepted: two minutes of 16 kHz mono 16-bit audio, plus header. */
export const MAX_SPEECH_RECORDING_BYTES = 2 * 60 * 16_000 * 2 + 44

/** Longest transcript returned; a two-minute question is far shorter. */
const MAX_TRANSCRIPT_LENGTH = 4_000

/** One request to the worker: the recording to read and where to write its text. */
type TranscriptionRequest = { inputPath: string; outputPath: string }

const workerScript = join(process.cwd(), "scripts", "speech-to-text-worker.py")

/** One process-wide worker survives development reloads, like Kokoro's. */
type SpeechToTextState = {
  worker?: KokoroWorker<TranscriptionRequest>
  queue: SpeechQueue
  exitHandlerInstalled?: boolean
}
const processState = globalThis as typeof globalThis & {
  __blitzSpeechToText?: SpeechToTextState
}
const state = (processState.__blitzSpeechToText ??= { queue: new SpeechQueue() })

/**
 * The shared worker. The first start may download the model (about 630 MB),
 * so startup gets longer than Kokoro's; it stays loaded for five idle minutes,
 * long enough to cover the pauses in a spoken lesson.
 */
const worker = (state.worker ??= new KokoroWorker<TranscriptionRequest>({
  spawnWorker: () =>
    spawn(/* turbopackIgnore: true */ pythonExecutable, [workerScript], {
      cwd: dirname(workerScript),
      env: { ...process.env, BLITZ_KOKORO_DIR: dataDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams,
  startupTimeoutMs: 20 * 60_000,
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 5 * 60_000,
  timeoutMessage: "That recording took too long to transcribe. Try a shorter question.",
}))
if (!state.exitHandlerInstalled) {
  state.exitHandlerInstalled = true
  process.once("exit", () => worker.killNow())
}

/** A recording Blitz cannot accept, with copy the learner can act on. */
export class SpeechRecordingError extends Error {
  /** Creates one recording error with its recovery copy. */
  constructor(message: string) {
    super(message)
    this.name = "SpeechRecordingError"
  }
}

/** Reads an ASCII tag from a byte buffer. */
function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

/**
 * Checks that a recording is a WAV file the worker can read: RIFF/WAVE with
 * 16-bit PCM, mono, at 16 kHz, within the size bound.
 *
 * @throws SpeechRecordingError with recovery copy when it is not.
 */
export function validateSpeechRecording(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SPEECH_RECORDING_BYTES)
    throw new SpeechRecordingError("That recording is too long. Keep questions under two minutes.")
  if (bytes.byteLength <= 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE")
    throw new SpeechRecordingError("That recording could not be read. Try again.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The browser writes the canonical 44-byte header: fmt chunk first.
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)
  if (
    tag(bytes, 12) !== "fmt " ||
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== 16_000 ||
    bitsPerSample !== 16
  )
    throw new SpeechRecordingError("That recording could not be read. Try again.")
}

/** Starts the worker ahead of the first question, downloading the model if needed. */
export async function warmSpeechToText(): Promise<void> {
  if (process.platform !== "darwin")
    throw new KokoroUnavailableError(
      "Speaking questions is currently available on macOS only."
    )
  await worker.start()
}

/**
 * Transcribes one recording on the Mac.
 *
 * @param recording - 16 kHz mono 16-bit PCM WAV bytes.
 * @param signal - Drops the request if the learner cancels while it waits.
 * @returns The transcript, trimmed and bounded; empty when nothing was heard.
 * @throws SpeechRecordingError for an invalid recording; KokoroUnavailableError when the
 *   local setup is missing or the worker fails.
 */
export async function transcribeSpeech(
  recording: Uint8Array,
  signal?: AbortSignal
): Promise<string> {
  validateSpeechRecording(recording)
  await warmSpeechToText()
  const directory = await mkdtemp(join(tmpdir(), "blitz-speech-"))
  try {
    const inputPath = join(directory, `${randomUUID()}.wav`)
    const outputPath = join(directory, `${randomUUID()}.txt`)
    await writeFile(inputPath, recording, { mode: 0o600 })
    await state.queue.enqueue(
      `transcribe:${inputPath}`,
      () => worker.synthesize({ inputPath, outputPath }),
      { priority: "playback", ...(signal ? { signal } : {}) }
    )
    const text = (await readFile(outputPath, "utf8")).replace(/\s+/g, " ").trim()
    return text.slice(0, MAX_TRANSCRIPT_LENGTH)
  } finally {
    // Recordings and transcripts are never kept.
    await rm(directory, { recursive: true, force: true })
  }
}
