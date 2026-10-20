/** Verifies saved playback restoration and completion behavior. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  bindListeningProgress,
  listeningProgressKey,
  type ListeningProgressStorage,
} from "../lib/client/listening-progress.ts"

/** Small storage mock that can model disabled browser storage. */
class MemoryStorage implements ListeningProgressStorage {
  /** Stored values indexed by the browser key. */
  readonly values = new Map<string, string>()

  /** Reads a stored value or throws when storage is disabled. */
  getItem(key: string): string | null {
    if (this.disabled) throw new Error("storage disabled")
    return this.values.get(key) ?? null
  }

  /** Writes a stored value or throws when storage is disabled. */
  setItem(key: string, value: string): void {
    if (this.disabled) throw new Error("storage disabled")
    this.values.set(key, value)
  }

  /** Removes a stored value or throws when storage is disabled. */
  removeItem(key: string): void {
    if (this.disabled) throw new Error("storage disabled")
    this.values.delete(key)
  }

  /** Makes each operation fail to mirror a blocked localStorage area. */
  disabled = false
}

/** Audio element double with controllable metadata and named events. */
class FakeAudio {
  /** Browser ready state, initially before metadata. */
  readyState = 0
  /** Recording length in seconds. */
  duration = 100
  /** Current playback position in seconds. */
  currentTime = 0
  /** Event handlers attached by the progress controller. */
  private readonly listeners = new Map<string, Set<() => void>>()

  /** Registers a listener for a media event. */
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>()
    listeners.add(listener as () => void)
    this.listeners.set(type, listeners)
  }

  /** Removes a previously registered media listener. */
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as () => void)
  }

  /** Dispatches one media event to the registered handlers. */
  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener())
  }
}

/** Creates the browser interface expected by the controller from a test double. */
function browserAudio(audio: FakeAudio): HTMLAudioElement {
  return audio as unknown as HTMLAudioElement
}

test("restores after metadata, then saves time updates and flushes", () => {
  const storage = new MemoryStorage()
  const key = listeningProgressKey("project", "recording")
  storage.values.set(key, "37.5")
  const audio = new FakeAudio()
  const positions: number[] = []
  const progress = bindListeningProgress({
    audio: browserAudio(audio),
    storage,
    key,
    onPosition: (seconds) => positions.push(seconds),
  })

  audio.emit("timeupdate")
  assert.equal(storage.values.get(key), "37.5")
  assert.equal(audio.currentTime, 0)

  audio.readyState = 1
  audio.emit("loadedmetadata")
  assert.equal(audio.currentTime, 37.5)
  assert.deepEqual(positions, [37.5])

  audio.currentTime = 42
  audio.emit("timeupdate")
  assert.equal(storage.values.get(key), "42")
  audio.currentTime = 48
  progress.flush()
  assert.equal(storage.values.get(key), "48")
  progress.dispose()
})

test("keeps recordings separate and removes completed or out-of-range positions", () => {
  const storage = new MemoryStorage()
  const firstKey = listeningProgressKey("project", "first")
  const secondKey = listeningProgressKey("project", "second")
  assert.notEqual(firstKey, secondKey)
  storage.values.set(firstKey, "20")
  storage.values.set(secondKey, "99")

  const completedAudio = new FakeAudio()
  completedAudio.readyState = 1
  completedAudio.duration = 20
  const completed = bindListeningProgress({
    audio: browserAudio(completedAudio),
    storage,
    key: firstKey,
    onPosition: () => undefined,
  })
  assert.equal(completedAudio.currentTime, 0)
  assert.equal(storage.values.has(firstKey), false)

  const audio = new FakeAudio()
  audio.readyState = 1
  const progress = bindListeningProgress({
    audio: browserAudio(audio),
    storage,
    key: secondKey,
    onPosition: () => undefined,
  })
  audio.currentTime = audio.duration
  audio.emit("ended")
  assert.equal(storage.values.has(secondKey), false)
  completed.dispose()
  progress.dispose()
})

test("discards malformed values and continues when storage is unavailable", () => {
  const storage = new MemoryStorage()
  const malformedKey = listeningProgressKey("project", "malformed")
  storage.values.set(malformedKey, "{bad json")
  const malformedAudio = new FakeAudio()
  malformedAudio.readyState = 1
  const malformed = bindListeningProgress({
    audio: browserAudio(malformedAudio),
    storage,
    key: malformedKey,
    onPosition: () => undefined,
  })
  assert.equal(storage.values.has(malformedKey), false)

  storage.disabled = true
  const unavailableAudio = new FakeAudio()
  unavailableAudio.readyState = 1
  const unavailable = bindListeningProgress({
    audio: browserAudio(unavailableAudio),
    storage,
    key: listeningProgressKey("project", "unavailable"),
    onPosition: () => undefined,
  })
  unavailableAudio.currentTime = 12
  unavailableAudio.emit("pause")
  unavailable.dispose()
  malformed.dispose()
})
