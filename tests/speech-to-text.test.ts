/** Checks transcription file ownership when callers cancel queued or active inference. */

import assert from "node:assert/strict"
import { access, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import test from "node:test"

import { SpeechQueue } from "../lib/server/speech-queue.ts"
import { encodePcm16Wav } from "../lib/speech-wav.ts"

/** Creates a barrier so the fake worker can outlive its cancelled request. */
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

type WorkerRequest = { inputPath: string; outputPath: string }
const queue = new SpeechQueue()
let synthesize: (request: WorkerRequest) => Promise<void>
const fakeWorker = {
  start: async () => undefined,
  synthesize: (request: WorkerRequest) => synthesize(request),
  killNow: () => undefined,
}

/** Installs the fake persistent worker before loading the real transcription entry point. */
async function loadTranscriber() {
  const target = globalThis as typeof globalThis & { __blitzSpeechToText?: unknown }
  target.__blitzSpeechToText = { queue, worker: fakeWorker, exitHandlerInstalled: true }
  type Context = { conditions: string[]; parentURL?: string }
  type Result = { url: string; format?: string }
  const { registerHooks } = await import("node:module") as unknown as {
    registerHooks: (hooks: {
      resolve: (specifier: string, context: Context, next: (specifier: string, context: Context) => Result) => Result
    }) => { deregister: () => void }
  }
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("@/"))
        return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context)
      try {
        return next(specifier, context)
      } catch (error) {
        if (specifier.startsWith("."))
          for (const suffix of [".ts", ".js"]) {
            try { return next(specifier + suffix, context) } catch { /* Try the next extension. */ }
          }
        throw error
      }
    },
  })
  try {
    return (await import("../lib/server/speech-to-text.ts")).transcribeSpeech
  } finally {
    hook.deregister()
  }
}

test("cancelled active transcription keeps files until inference ends, then removes late output", { skip: process.platform !== "darwin" }, async () => {
  const transcribe = await loadTranscriber()
  const started = barrier()
  const finish = barrier()
  let directory = ""
  const wav = encodePcm16Wav(new Float32Array(160))
  synthesize = async ({ inputPath, outputPath }) => {
    directory = dirname(inputPath)
    started.release()
    await finish.promise
    assert.deepEqual(new Uint8Array(await readFile(inputPath)), wav)
    await writeFile(outputPath, "  a late transcript  ")
  }
  const controller = new AbortController()
  const pending = transcribe(wav, controller.signal)
  const aborted = assert.rejects(pending, { name: "AbortError" })
  try {
    await started.promise
    controller.abort()
    await aborted
    await access(directory)
  } finally {
    finish.release()
    // This task starts only after the active worker and its cleanup settle.
    await queue.enqueue("drain", async () => undefined)
  }
  await assert.rejects(access(directory), { code: "ENOENT" })
})

test("a pending cancellation skips inference, and normal and failed work clean up", { skip: process.platform !== "darwin" }, async () => {
  const transcribe = await loadTranscriber()
  const gate = barrier()
  const active = queue.enqueue("hold", () => gate.promise)
  let calls = 0
  let directory = ""
  synthesize = async ({ inputPath, outputPath }) => {
    calls += 1
    directory = dirname(inputPath)
    await writeFile(outputPath, "  a\n question  ")
  }
  const controller = new AbortController()
  const cancelled = transcribe(encodePcm16Wav(new Float32Array(160)), controller.signal)
  const aborted = assert.rejects(cancelled, { name: "AbortError" })
  controller.abort()
  gate.release()
  await Promise.all([active, aborted])
  assert.equal(calls, 0)
  assert.equal(await transcribe(encodePcm16Wav(new Float32Array(160))), "a question")
  await assert.rejects(access(directory), { code: "ENOENT" })
  synthesize = async ({ inputPath }) => {
    directory = dirname(inputPath)
    throw new Error("inference failed")
  }
  await assert.rejects(transcribe(encodePcm16Wav(new Float32Array(160))), /inference failed/)
  await assert.rejects(access(directory), { code: "ENOENT" })
})
