/** Owns the local Kokoro process and bounded read-aloud cache used by speech routes. */

import { createHash, randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  access,
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
import { SpeechQueue, type SpeechQueueOptions } from "./speech-queue"
import { KokoroWorker, KokoroUnavailableError } from "./kokoro-worker"

export { KokoroUnavailableError } from "./kokoro-worker"

/** Maximum text accepted by a single inference request; callers can submit multiple chunks. */
export const KOKORO_MAX_TEXT_LENGTH = 12_000

/** Private folder for Kokoro's model, voices, cache and Python environment. */
export const dataDirectory = resolve(
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
/** Python that runs the local speech workers, Kokoro's and speech to text. */
export const pythonExecutable =
  process.env.BLITZ_KOKORO_PYTHON?.trim() ||
  join(dataDirectory, "venv", "bin", "python3")

/** One process-wide runtime survives development reloads and shares startup with route bundles. */
type KokoroState = {
  runtime?: KokoroWorker
  queue: SpeechQueue
  readAloudCacheMaintenance: Promise<void>
  readAloudCacheReady?: Promise<boolean>
  exitHandlerInstalled?: boolean
}
const processState = globalThis as typeof globalThis & {
  __blitzKokoro?: KokoroState
}
const state = (processState.__blitzKokoro ??= {
  queue: new SpeechQueue(),
  readAloudCacheMaintenance: Promise.resolve(),
})

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

/** Shares bounded worker ownership across development reloads and route bundles. */
const runtime = (state.runtime ??= new KokoroWorker({
  spawnWorker: () =>
    spawn(/* turbopackIgnore: true */ pythonExecutable, [workerScript], {
      cwd: dirname(workerScript),
      env: { ...process.env, BLITZ_KOKORO_DIR: dataDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams,
}))

/** Runs one bounded inference; queued cancellation preserves other speech consumers. */
async function runSynthesis(request: {
  text: string
  voiceId: KokoroVoiceId
  outputPath: string
}): Promise<void> {
  await runtime.synthesize(request)
}

/** Loads installed assets ahead of the first click without downloading anything at server startup. */
export async function warmKokoro(): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    await Promise.all([
      access(pythonExecutable),
      access(join(dataDirectory, "kokoro-v1.0.onnx")),
      access(join(dataDirectory, "voices-v1.0.bin")),
    ])
  } catch {
    return
  }
  await Promise.all([runtime.start(), prepareReadAloudCache()])
}

/** Writes one WAV file using the persistent local Kokoro model. */
export async function synthesizeKokoroToFile(
  options: {
    text: string
    voiceId: KokoroVoiceId
    outputPath: string
  } & SpeechQueueOptions
): Promise<void> {
  validateRequest(options.text, options.voiceId)
  const outputPath = resolve(options.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await state.queue.enqueue(
    `file:${outputPath}`,
    () =>
      runSynthesis({
        text: options.text,
        voiceId: options.voiceId,
        outputPath,
      }),
    options
  )
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
  const current = state.readAloudCacheMaintenance.then(
    pruneReadAloudCache,
    pruneReadAloudCache
  )
  state.readAloudCacheMaintenance = current.then(
    () => undefined,
    () => undefined
  )
  return current
}

/** Initializes the cache once and allows speech to continue if local caching fails. */
function prepareReadAloudCache(): Promise<boolean> {
  if (!state.readAloudCacheReady) {
    state.readAloudCacheReady = queueReadAloudCacheMaintenance().then(
      () => true,
      () => {
        state.readAloudCacheReady = undefined
        return false
      }
    )
  }
  return state.readAloudCacheReady
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
    await runSynthesis({ ...options, outputPath })
    return await readFile(outputPath)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** Returns local speech and reuses recent WAVs from a size- and age-limited cache. */
export async function synthesizeKokoroWav(
  options: {
    text: string
    voiceId: KokoroVoiceId
  } & SpeechQueueOptions
): Promise<Buffer> {
  validateRequest(options.text, options.voiceId)
  options.signal?.throwIfAborted()
  const key = createHash("sha256")
    .update(`read-aloud-v1\0${options.voiceId}\0${options.text}`, "utf8")
    .digest("hex")
  const cacheAvailable = await prepareReadAloudCache()

  try {
    const cached = cacheAvailable ? await readCachedReadAloud(key) : undefined
    if (cached) {
      options.signal?.throwIfAborted()
      return cached
    }
  } catch {
    // A cache read failure must not prevent the requested speech from playing.
  }

  options.signal?.throwIfAborted()
  return state.queue.enqueue(
    `wav:${key}`,
    async () => {
      // Another request may have filled the cache while this task waited for the model.
      if (cacheAvailable) {
        try {
          const cached = await readCachedReadAloud(key)
          if (cached) return cached
        } catch {
          // Continue with synthesis when optional cache access fails.
        }
      }
      const audio = await synthesizeKokoroWavUncached({
        text: options.text,
        voiceId: options.voiceId,
      })
      if (cacheAvailable) {
        try {
          await writeCachedReadAloud(key, audio)
          // Eviction is optional maintenance and must not delay the first audible section.
          void queueReadAloudCacheMaintenance().catch(() => undefined)
        } catch {
          // Keep speech available even when the optional cache is full or unwritable.
        }
      }
      return audio
    },
    options
  )
}

/** Stops the resident worker when the Node.js process exits. */
if (!state.exitHandlerInstalled) {
  state.exitHandlerInstalled = true
  process.once("exit", () => state.runtime?.killNow())
}
