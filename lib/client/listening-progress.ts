/** Saves one listening room's playback position in this browser. */

/** Storage methods needed by the listening progress cache. */
export interface ListeningProgressStorage {
  /** Reads a saved position, or null when no position exists. */
  getItem(key: string): string | null
  /** Saves a serialized position for this recording. */
  setItem(key: string, value: string): void
  /** Removes a recording position after completion or invalid data. */
  removeItem(key: string): void
}

/** Builds a stable local key that keeps projects and recordings separate. */
export function listeningProgressKey(
  projectId: string,
  audioId: string
): string {
  return `blitz_listening_progress_v1:${JSON.stringify([projectId, audioId])}`
}

/** Creates event bindings that restore once metadata is ready and save playback changes. */
export function bindListeningProgress(options: {
  audio: HTMLAudioElement
  storage: ListeningProgressStorage | null
  key: string
  onPosition: (seconds: number) => void
}): { flush: () => void; dispose: () => void } {
  const { audio, storage, key, onPosition } = options
  let restored = false
  let disposed = false

  /** Removes a stored value when browser storage remains available. */
  function clearSavedPosition(): void {
    try {
      storage?.removeItem(key)
    } catch {
      // Storage can be disabled or full; playback still works without it.
    }
  }

  /** Restores the saved time once the browser knows the recording duration. */
  function restore(): void {
    if (restored || audio.readyState < 1) return
    restored = true
    let saved: number | null = null
    try {
      const raw = storage?.getItem(key)
      if (raw !== null && raw !== undefined) {
        const parsed: unknown = JSON.parse(raw)
        if (
          typeof parsed === "number" &&
          Number.isFinite(parsed) &&
          parsed >= 0
        )
          saved = parsed
        else clearSavedPosition()
      }
    } catch {
      clearSavedPosition()
    }

    if (
      saved !== null &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    ) {
      if (saved < audio.duration) audio.currentTime = saved
      else clearSavedPosition()
    }
    onPosition(audio.currentTime)
  }

  /** Saves the current time only after restoration, clearing completed audio. */
  function persist(): void {
    if (disposed) return
    restore()
    if (!restored) return
    if (
      Number.isFinite(audio.duration) &&
      audio.duration > 0 &&
      audio.currentTime >= audio.duration
    ) {
      clearSavedPosition()
      return
    }
    if (!Number.isFinite(audio.currentTime) || audio.currentTime < 0) return
    try {
      storage?.setItem(key, JSON.stringify(audio.currentTime))
    } catch {
      // Storage can be disabled or full; playback still works without it.
    }
  }

  /** Removes an ended recording's saved time and shows its final position. */
  function finish(): void {
    if (!restored) restore()
    clearSavedPosition()
    onPosition(audio.currentTime)
  }

  audio.addEventListener("loadedmetadata", restore)
  audio.addEventListener("timeupdate", persist)
  audio.addEventListener("seeked", persist)
  audio.addEventListener("pause", persist)
  audio.addEventListener("ended", finish)
  restore()

  /** Flushes the current position for page hide and visibility changes. */
  function flush(): void {
    persist()
  }

  /** Saves once and removes every listener when the listening room unmounts. */
  function dispose(): void {
    if (disposed) return
    persist()
    disposed = true
    audio.removeEventListener("loadedmetadata", restore)
    audio.removeEventListener("timeupdate", persist)
    audio.removeEventListener("seeked", persist)
    audio.removeEventListener("pause", persist)
    audio.removeEventListener("ended", finish)
  }

  return { flush, dispose }
}
