/** Coalesces assistant fragments and thoughts into ordered, bounded persistence writes. */

/** Creates a writer that saves at most four snapshots per second and drains before terminal writes. */
export function createChatProgress(
  save: (reply: string, thought?: string) => Promise<unknown>,
  initialText = "",
  initialThought = ""
) {
  let text = initialText
  let saved = initialText
  let thought = initialThought
  let savedThought = initialThought
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  /** Saves the latest text and thought with at most one request in flight, coalescing slow writes. */
  function write(): Promise<void> {
    timer = undefined
    const snapshot = text
    const thoughtSnapshot = thought
    pending = Promise.resolve().then(async () => {
      try {
        if (snapshot !== saved || thoughtSnapshot !== savedThought) {
          await save(snapshot, thoughtSnapshot || undefined)
          saved = snapshot
          savedThought = thoughtSnapshot
        }
      } catch {
        // Completion persists the authoritative answer even if a progress write fails.
      } finally {
        pending = undefined
        if (!stopped && (text !== snapshot || thought !== thoughtSnapshot))
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
    /** Appends thought trace text without blocking the transport or queuing stale snapshots. */
    appendThought(delta: string) {
      if (stopped || !delta) return
      thought = (thought + delta).slice(0, 250_000)
      if (!timer && !pending) timer = setTimeout(() => void write(), 250)
    },
    /** Drains remaining text and thoughts before completion, failure, or lease release. */
    async finish() {
      stopped = true
      if (timer) clearTimeout(timer)
      await pending
      if (text !== saved || thought !== savedThought) await write()
    },
  }
}
