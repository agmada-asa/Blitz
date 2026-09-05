/** Coalesces assistant fragments into ordered, bounded persistence writes. */

/** Creates a writer that saves at most four snapshots per second and drains before terminal writes. */
export function createChatProgress(
  save: (reply: string) => Promise<unknown>,
  initialText = ""
) {
  let text = initialText
  let saved = initialText
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  /** Saves the latest text with at most one request in flight, coalescing slow writes. */
  function write(): Promise<void> {
    timer = undefined
    const snapshot = text
    pending = Promise.resolve().then(async () => {
      try {
        if (snapshot !== saved) {
          await save(snapshot)
          saved = snapshot
        }
      } catch {
        // Completion persists the authoritative answer even if a progress write fails.
      } finally {
        pending = undefined
        if (!stopped && text !== snapshot)
          timer = setTimeout(() => void write(), 250)
      }
    })
    return pending
  }
  return {
    /** Appends transport text without blocking the transport or queuing stale snapshots. */
    append(delta: string) {
      if (stopped || !delta) return
      text = (text + delta).slice(0, 250_000)
      if (!timer && !pending) timer = setTimeout(() => void write(), 250)
    },
    /** Drains remaining text before completion, failure, or lease release. */
    async finish() {
      stopped = true
      if (timer) clearTimeout(timer)
      await pending
      if (text !== saved) await write()
    },
  }
}
