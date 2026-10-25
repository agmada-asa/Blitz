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
import { validateSpeechWav } from "../speech-wav"

export { MAX_SPEECH_RECORDING_BYTES, SpeechRecordingError } from "../speech-wav"

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
  validateSpeechWav(recording)
  await warmSpeechToText()
  return state.queue.enqueue(
    `transcribe:${randomUUID()}`,
    async () => {
      // The queue lets active inference finish after its consumer cancels.
      // Keep its files until then; a cancelled pending task creates none.
      const directory = await mkdtemp(join(tmpdir(), "blitz-speech-"))
      try {
        const inputPath = join(directory, `${randomUUID()}.wav`)
        const outputPath = join(directory, `${randomUUID()}.txt`)
        await writeFile(inputPath, recording, { mode: 0o600 })
        await worker.synthesize({ inputPath, outputPath })
        const text = (await readFile(outputPath, "utf8")).replace(/\s+/g, " ").trim()
        return text.slice(0, MAX_TRANSCRIPT_LENGTH)
      } finally {
        // Also remove late output from an inference whose caller cancelled.
        await rm(directory, { recursive: true, force: true })
      }
    },
    { priority: "playback", ...(signal ? { signal } : {}) }
  )
}
