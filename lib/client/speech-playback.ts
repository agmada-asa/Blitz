/** Prepares bounded local speech openings and schedules continuous, cancellable browser playback. */

/** Small browser cache avoids another HTTP round trip for recently prepared sections. */
const CACHE_LIMIT_BYTES = 8 * 1024 * 1024
/** Entry count also bounds retained text keys for short sections. */
const CACHE_LIMIT_ENTRIES = 24
/** Browser openings expire sooner than the private disk cache. */
const CACHE_MAX_AGE_MS = 10 * 60 * 1_000

type CachedSpeech = { audio: ArrayBuffer; expiresAt: number }
const cache = new Map<string, CachedSpeech>()
let context: AudioContext | undefined
let preparation: { key: string; controller: AbortController } | undefined
let activePlaybacks = 0

/** Returns a voice-sensitive browser key; the map is bounded and never persisted. */
function speechKey(text: string, voiceId: string): string {
  return JSON.stringify([voiceId, text])
}

/** Returns a fresh cached section and refreshes its position for eviction. */
function cachedSpeech(key: string): ArrayBuffer | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  if (entry.expiresAt <= Date.now()) return undefined
  cache.set(key, entry)
  return entry.audio
}

/** Stores reusable bytes and evicts old sections to bound browser memory. */
function rememberSpeech(key: string, audio: ArrayBuffer): void {
  cache.delete(key)
  cache.set(key, { audio, expiresAt: Date.now() + CACHE_MAX_AGE_MS })
  let bytes = [...cache.values()].reduce(
    (total, entry) => total + entry.audio.byteLength,
    0
  )
  for (const [oldKey, entry] of cache) {
    if (bytes <= CACHE_LIMIT_BYTES && cache.size <= CACHE_LIMIT_ENTRIES) break
    cache.delete(oldKey)
    bytes -= entry.audio.byteLength
  }
}

/** Fetches a WAV or reuses prepared bytes; foreground requests promote matching server work. */
async function requestSpeech(
  text: string,
  voiceId: string,
  signal: AbortSignal,
  isPreparation = false
): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  const key = speechKey(text, voiceId)
  const cached = cachedSpeech(key)
  if (cached) return cached
  const response = await fetch("/api/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voiceId, preparation: isPreparation }),
    signal,
  })
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(result?.error || "Audio could not be generated. Try again.")
  }
  const audio = await response.arrayBuffer()
  signal.throwIfAborted()
  rememberSpeech(key, audio)
  return audio
}

/** Cancels speculative work so the next user-requested section gets playback priority. */
function cancelPreparation(): void {
  preparation?.controller.abort()
  preparation = undefined
}

/** Quietly prepares one opening; callers release it when content changes or disappears. */
export function prepareSpeechOpening(
  text: string,
  voiceId: string
): () => void {
  const key = speechKey(text, voiceId)
  if (!text || activePlaybacks || cachedSpeech(key) || preparation?.key === key)
    return () => {}
  cancelPreparation()
  const controller = new AbortController()
  const current = { key, controller }
  preparation = current
  void requestSpeech(text, voiceId, controller.signal, true)
    .catch(() => undefined)
    .finally(() => {
      if (preparation === current) preparation = undefined
    })
  return () => {
    if (preparation === current) cancelPreparation()
  }
}

/** Creates the single audio context on demand; resume must happen during the user's click. */
function speechContext(): AudioContext {
  if (!context || context.state === "closed") context = new AudioContext()
  return context
}

/** Lets stop or navigation release a player even if the browser never resumes its audio context. */
function waitForAudioResume(
  resumed: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    /** Drops the abort listener once resume completes, fails, or is cancelled. */
    function cleanup(): void {
      signal.removeEventListener("abort", onAbort)
    }
    /** Rejects promptly when playback stops during browser audio permission handling. */
    function onAbort(): void {
      cleanup()
      reject(new DOMException("Audio playback stopped.", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    resumed.then(
      () => {
        cleanup()
        resolve()
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

/** Schedules at most two decoded sections ahead, stops promptly, and propagates real playback errors. */
export async function playSpeechSections(
  chunks: readonly string[],
  voiceId: string,
  signal: AbortSignal,
  onState: (state: "loading" | "playing") => void
): Promise<void> {
  signal.throwIfAborted()
  const audioContext = speechContext()
  // Invoke resume before the first await to preserve the browser's user activation.
  const resumed = audioContext.resume()
  activePlaybacks += 1
  cancelPreparation()
  const sources = new Set<AudioBufferSourceNode>()
  const pending: Promise<void>[] = []
  let scheduledThrough = audioContext.currentTime
  let preparing = true

  /** Stops current and scheduled sections together when the owning control is cancelled. */
  function stopSources(): void {
    for (const source of sources) source.stop()
  }
  signal.addEventListener("abort", stopSources, { once: true })
  try {
    await waitForAudioResume(resumed, signal)
    signal.throwIfAborted()
    if (audioContext.state !== "running")
      throw new Error("Audio could not start. Try reading aloud again.")
    for (const chunk of chunks) {
      // Bound synthesis and decoded buffers even when the text contains many sections.
      if (pending.length >= 2) await pending.shift()
      signal.throwIfAborted()
      const bytes = await requestSpeech(chunk, voiceId, signal)
      const buffer = await audioContext.decodeAudioData(bytes.slice(0))
      signal.throwIfAborted()
      const source = audioContext.createBufferSource()
      source.buffer = buffer
      source.connect(audioContext.destination)
      sources.add(source)
      const ended = new Promise<void>((resolve) => {
        /** Releases each section and reports a buffer underrun only while more speech is coming. */
        source.onended = () => {
          sources.delete(source)
          source.disconnect()
          if (!sources.size && preparing && !signal.aborted) onState("loading")
          resolve()
        }
      })
      const startsAt = Math.max(
        audioContext.currentTime + 0.015,
        scheduledThrough
      )
      source.start(startsAt)
      scheduledThrough = startsAt + buffer.duration
      pending.push(ended)
      onState("playing")
    }
    preparing = false
    await Promise.all(pending)
    signal.throwIfAborted()
  } finally {
    preparing = false
    signal.removeEventListener("abort", stopSources)
    stopSources()
    activePlaybacks -= 1
  }
}
