/** Owns the local Kokoro process and bounded read-aloud cache used by speech routes. */

import { createHash, randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isKokoroVoiceId, type KokoroVoiceId } from "@/lib/kokoro-voices"

/** Maximum text accepted by a single inference request; callers can submit multiple chunks. */
export const KOKORO_MAX_TEXT_LENGTH = 12_000

/** Describes a local runtime setup or inference failure in user-facing language. */
export class KokoroUnavailableError extends Error {
  /** Creates an error suitable for an API response or background job status. */
  constructor(message: string) {
    super(message)
    this.name = "KokoroUnavailableError"
  }
}

type SpeechRequest = {
  text: string
  voiceId: KokoroVoiceId
  outputPath: string
}

type WorkerReply =
  | { ready: true }
  | { ready: false; error: string }
  | { ok: boolean; error?: string }

const dataDirectory = resolve(
  /* turbopackIgnore: true */
  process.env.BLITZ_KOKORO_DIR ??
    join(homedir(), "Library", "Application Support", "Blitz", "kokoro")
)
/** Stores only recent read-aloud WAV output, not the source text. */
const readAloudCacheDirectory = join(dataDirectory, "read-aloud-cache")
/** Maximum disk space reserved for read-aloud WAV cache entries. */
const READ_ALOUD_CACHE_LIMIT_BYTES = 500 * 1024 * 1024
/** Removes read-aloud audio after one week without a cache hit. */
const READ_ALOUD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
/** Removes abandoned atomic-write files after one hour. */
const READ_ALOUD_TEMP_MAX_AGE_MS = 60 * 60 * 1_000
const workerScript = join(process.cwd(), "scripts", "kokoro-worker.py")
const pythonExecutable =
  process.env.BLITZ_KOKORO_PYTHON?.trim() ||
  join(dataDirectory, "venv", "bin", "python3")

let worker: ChildProcessWithoutNullStreams | undefined
let workerReady: Promise<void> | undefined
let serializedSynthesis: Promise<void> = Promise.resolve()
let readAloudCacheMaintenance: Promise<void> = Promise.resolve()
let readAloudCacheReady: Promise<boolean> | undefined
/** Deduplicates simultaneous speech requests for the same text and voice. */
const readAloudInFlight = new Map<string, Promise<Buffer>>()

/** Validates a request shared by API calls and trusted long form job code. */
function validateRequest(
  text: string,
  voiceId: string
): asserts voiceId is KokoroVoiceId {
  if (process.platform !== "darwin") {
    throw new KokoroUnavailableError(
      "Local Kokoro speech is currently available on macOS only."
    )
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Speech text must not be empty.")
  }
  if (text.length > KOKORO_MAX_TEXT_LENGTH) {
    throw new Error(
      `Speech text must be ${KOKORO_MAX_TEXT_LENGTH.toLocaleString()} characters or fewer per request.`
    )
  }
  if (!isKokoroVoiceId(voiceId)) {
    throw new Error("Choose one of the available Kokoro voices.")
  }
}

/** Starts the resident worker and waits for its one-time model load. */
async function startWorker(): Promise<void> {
  if (workerReady) return workerReady
  const readiness = new Promise<void>((resolveReady, rejectReady) => {
    void mkdir(dataDirectory, { recursive: true })
      .then(() => {
        const child = spawn(/* turbopackIgnore: true */ pythonExecutable, [workerScript], {
          cwd: dirname(workerScript),
          env: { ...process.env, BLITZ_KOKORO_DIR: dataDirectory },
          stdio: ["pipe", "pipe", "pipe"],
        })
        worker = child
        let stderr = ""
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
        })
        const lines = createInterface({ input: child.stdout })
        const startupTimer = setTimeout(() => {
          rejectReady(
            new KokoroUnavailableError(
              "Kokoro is taking too long to start. Check the local setup and try again."
            )
          )
          child.kill()
        }, 180_000)
        let initialized = false
        lines.on("line", (line) => {
          let message: WorkerReply
          try {
            message = JSON.parse(line) as WorkerReply
          } catch {
            return
          }
          if (!initialized) {
            initialized = true
            clearTimeout(startupTimer)
            if ("ready" in message && message.ready) resolveReady()
            else
              rejectReady(
                new KokoroUnavailableError(
                  "Kokoro could not start. Run scripts/setup-kokoro.sh and try again. " +
                    (("error" in message && message.error) || "")
                )
              )
            return
          }
          if ("ok" in message) {
            const reply = activeReply
            activeReply = undefined
            if (message.ok) reply?.resolve()
            else
              reply?.reject(
                new Error(message.error || "Kokoro could not create the audio.")
              )
          }
        })
        child.once("error", (error) => {
          clearTimeout(startupTimer)
          const failure = new KokoroUnavailableError(
            error.message.includes("ENOENT")
              ? "Kokoro is not installed. Run scripts/setup-kokoro.sh, then restart Blitz."
              : `Kokoro could not start: ${error.message}`
          )
          if (!initialized) rejectReady(failure)
          activeReply?.reject(failure)
          activeReply = undefined
          worker = undefined
          workerReady = undefined
        })
        child.once("exit", (code) => {
          clearTimeout(startupTimer)
          const failure = new KokoroUnavailableError(
            `The local Kokoro worker stopped${code === null ? "" : ` (exit ${code})`}.${stderr ? ` ${stderr.trim()}` : ""}`
          )
          if (!initialized) rejectReady(failure)
          activeReply?.reject(failure)
          worker = undefined
          workerReady = undefined
        })
      })
      .catch((error: unknown) => {
        rejectReady(
          new KokoroUnavailableError(
            error instanceof Error
              ? error.message
              : "Kokoro could not prepare its local data folder."
          )
        )
      })
  })
  workerReady = readiness.catch((error: unknown) => {
    workerReady = undefined
    throw error
  })
  return workerReady
}

let activeReply:
  { resolve: () => void; reject: (error: Error) => void } | undefined

/** Sends one request to the resident process after startup has loaded the model. */
async function sendRequest(request: SpeechRequest): Promise<void> {
  await startWorker()
  const child = worker
  if (
    !child ||
    child.killed ||
    child.exitCode !== null ||
    child.stdin.destroyed
  ) {
    worker = undefined
    workerReady = undefined
    await startWorker()
    return sendRequest(request)
  }
  await new Promise<void>((resolveReply, rejectReply) => {
    activeReply = { resolve: resolveReply, reject: rejectReply }
    child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error) return
      activeReply = undefined
      rejectReply(
        new KokoroUnavailableError(
          "The local Kokoro worker stopped accepting requests."
        )
      )
    })
  })
}

/** Queues synthesis so callers share one model safely and later work can restart after a crash. */
async function queuedSynthesis(request: SpeechRequest): Promise<void> {
  const current = serializedSynthesis.then(async () => {
    try {
      await sendRequest(request)
    } catch (error) {
      if (worker) worker.kill()
      worker = undefined
      workerReady = undefined
      throw error
    }
  })
  serializedSynthesis = current.then(
    () => undefined,
    () => undefined
  )
  return current
}

/** Writes one WAV file using the persistent local Kokoro model. */
export async function synthesizeKokoroToFile(options: {
  text: string
  voiceId: KokoroVoiceId
  outputPath: string
}): Promise<void> {
  validateRequest(options.text, options.voiceId)
  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await queuedSynthesis({ ...options, outputPath })
}

/** Resolves a cache key to its opaque WAV path inside the private app cache. */
function readAloudCachePath(key: string): string {
  return join(readAloudCacheDirectory, `${key}.wav`)
}

/** Removes expired or least-recently-used WAVs until the cache fits its limit. */
async function pruneReadAloudCache(): Promise<void> {
  await mkdir(readAloudCacheDirectory, { recursive: true, mode: 0o700 })
  await chmod(readAloudCacheDirectory, 0o700)
  const entries = await readdir(readAloudCacheDirectory, {
    withFileTypes: true,
  })
  const now = Date.now()
  const cachedFiles: Array<{
    path: string
    size: number
    lastUsedAt: number
  }> = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(readAloudCacheDirectory, entry.name)
    let details: Awaited<ReturnType<typeof stat>>
    try {
      details = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }

    if (entry.name.endsWith(".tmp")) {
      if (now - details.mtimeMs > READ_ALOUD_TEMP_MAX_AGE_MS)
        await rm(path, { force: true })
      continue
    }
    if (!/^[a-f0-9]{64}\.wav$/i.test(entry.name)) continue
    if (now - details.mtimeMs > READ_ALOUD_CACHE_MAX_AGE_MS) {
      await rm(path, { force: true })
      continue
    }
    cachedFiles.push({
      path,
      size: details.size,
      lastUsedAt: details.mtimeMs,
    })
  }

  let cachedBytes = cachedFiles.reduce((total, file) => total + file.size, 0)
  cachedFiles.sort((left, right) => left.lastUsedAt - right.lastUsedAt)
  for (const file of cachedFiles) {
    if (cachedBytes <= READ_ALOUD_CACHE_LIMIT_BYTES) break
    await rm(file.path, { force: true })
    cachedBytes -= file.size
  }
}

/** Serializes cache cleanup so concurrent speech requests cannot race eviction. */
function queueReadAloudCacheMaintenance(): Promise<void> {
  const current = readAloudCacheMaintenance.then(
    pruneReadAloudCache,
    pruneReadAloudCache
  )
  readAloudCacheMaintenance = current.then(
    () => undefined,
    () => undefined
  )
  return current
}

/** Initializes the cache once and allows speech to continue if local caching fails. */
function prepareReadAloudCache(): Promise<boolean> {
  if (!readAloudCacheReady) {
    readAloudCacheReady = queueReadAloudCacheMaintenance().then(
      () => true,
      () => {
        readAloudCacheReady = undefined
        return false
      }
    )
  }
  return readAloudCacheReady
}

/** Reads and marks a cached WAV as recently used without storing its source text. */
async function readCachedReadAloud(key: string): Promise<Buffer | undefined> {
  const path = readAloudCachePath(key)
  try {
    const details = await stat(path)
    if (Date.now() - details.mtimeMs > READ_ALOUD_CACHE_MAX_AGE_MS) {
      await rm(path, { force: true })
      return undefined
    }
    const audio = await readFile(path)
    const accessedAt = new Date()
    await utimes(path, accessedAt, accessedAt).catch(() => undefined)
    return audio
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Writes a WAV atomically with owner-only permissions for safe cache reuse. */
async function writeCachedReadAloud(key: string, audio: Buffer): Promise<void> {
  const temporaryPath = join(
    readAloudCacheDirectory,
    `${key}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporaryPath, audio, { flag: "wx", mode: 0o600 })
    await rename(temporaryPath, readAloudCachePath(key))
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

/** Synthesizes a WAV in an app-owned temporary folder and deletes it after reading. */
async function synthesizeKokoroWavUncached(options: {
  text: string
  voiceId: KokoroVoiceId
}): Promise<Buffer> {
  validateRequest(options.text, options.voiceId)
  await mkdir(dataDirectory, { recursive: true })
  const temporaryDirectory = await mkdtemp(join(dataDirectory, "speech-"))
  const outputPath = join(temporaryDirectory, "speech.wav")
  try {
    await synthesizeKokoroToFile({ ...options, outputPath })
    return await readFile(outputPath)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** Returns local speech and reuses recent WAVs from a size- and age-limited cache. */
export async function synthesizeKokoroWav(options: {
  text: string
  voiceId: KokoroVoiceId
}): Promise<Buffer> {
  validateRequest(options.text, options.voiceId)
  const key = createHash("sha256")
    .update(`read-aloud-v1\0${options.voiceId}\0${options.text}`, "utf8")
    .digest("hex")
  if (!(await prepareReadAloudCache()))
    return synthesizeKokoroWavUncached(options)

  try {
    const cached = await readCachedReadAloud(key)
    if (cached) return cached
  } catch {
    // A cache read failure must not prevent the requested speech from playing.
  }

  const current = readAloudInFlight.get(key)
  if (current) return current

  const generation = (async () => {
    const audio = await synthesizeKokoroWavUncached(options)
    try {
      await writeCachedReadAloud(key, audio)
      await queueReadAloudCacheMaintenance()
    } catch {
      // Keep the generated audio available even when the optional cache is full or unwritable.
    }
    return audio
  })()
  readAloudInFlight.set(key, generation)
  try {
    return await generation
  } finally {
    if (readAloudInFlight.get(key) === generation)
      readAloudInFlight.delete(key)
  }
}

/** Stops the resident worker when the Node.js process exits. */
process.once("exit", () => worker?.kill())
