/** Prepares bounded local speech openings and schedules continuous, cancellable browser playback. */
import { highlightSpeech } from "./speech-highlight.ts"

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

let analyser: AnalyserNode | undefined
let samples: Float32Array<ArrayBuffer> | undefined

/** Creates the single audio context on demand; resume must happen during the user's click. */
function speechContext(): AudioContext {
  if (!context || context.state === "closed") {
    context = new AudioContext()
    // Every section plays through one analyser, so the voice orb can move with the reply.
    analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.connect(context.destination)
    samples = new Float32Array(analyser.fftSize)
  }
  return context
}

/** How loud speech playback is right now, as RMS (0..1); 0 when nothing plays. */
export function speechOutputLevel(): number {
  if (!analyser || !samples || !activePlaybacks) return 0
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

/** Unlocks output during a microphone button's user gesture, before asynchronous model setup. */
export function unlockSpeech(): void { void speechContext().resume() }

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
  chunks: readonly string[] | AsyncIterable<string>,
  voiceId: string,
  signal: AbortSignal,
  onState: (state: "loading" | "playing") => void,
  onPiece?: (text: string, durationMs: number, phase: "playing" | "played", synthesisMs: number) => void
): Promise<void> {
  signal.throwIfAborted()
  const audioContext = speechContext()
  // Invoke resume before the first await to preserve the browser's user activation.
  const resumed = audioContext.resume()
  activePlaybacks += 1
  cancelPreparation()
  const sources = new Set<AudioBufferSourceNode>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let clearHighlight: (() => void) | undefined
  const pending: Promise<void>[] = []
  let scheduledThrough = audioContext.currentTime
  let preparing = true

  /** Stops current and scheduled sections together when the owning control is cancelled. */
  function stopSources(): void {
    for (const timer of timers) clearTimeout(timer)
    clearHighlight?.()
    for (const source of sources) source.stop()
  }
  signal.addEventListener("abort", stopSources, { once: true })
  try {
    await waitForAudioResume(resumed, signal)
    signal.throwIfAborted()
    if (audioContext.state !== "running")
      throw new Error("Audio could not start. Try reading aloud again.")
    for await (const chunk of chunks) {
      // Bound synthesis and decoded buffers even when the text contains many sections.
      if (pending.length >= 2) await pending.shift()
      signal.throwIfAborted()
      const requestedAt = performance.now()
      const bytes = await requestSpeech(chunk, voiceId, signal)
      const synthesisMs = performance.now() - requestedAt
      const buffer = await audioContext.decodeAudioData(bytes.slice(0))
      signal.throwIfAborted()
      const source = audioContext.createBufferSource()
      source.buffer = buffer
      source.connect(analyser ?? audioContext.destination)
      sources.add(source)
      const ended = new Promise<void>((resolve) => {
        /** Releases each section and reports a buffer underrun only while more speech is coming. */
        source.onended = () => {
          if (!signal.aborted) onPiece?.(chunk, buffer.duration * 1000, "played", synthesisMs)
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
      const timer = setTimeout(() => {
        timers.delete(timer)
        clearHighlight = highlightSpeech(chunk)
        onPiece?.(chunk, buffer.duration * 1000, "playing", synthesisMs)
      }, Math.max(0, (startsAt - audioContext.currentTime) * 1000))
      timers.add(timer)
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
