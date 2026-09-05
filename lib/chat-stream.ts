/** Reads reconnectable conversation streams in browsers and Expo without replaying questions. */

/** Decodes NDJSON across arbitrary byte boundaries, including split UTF-8 characters. */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onSnapshot: (value: unknown) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim()) onSnapshot(JSON.parse(line))
      }
      if (pending.length > 16_000_000)
        throw new Error("Chat response is too large")
      if (done) {
        if (pending.trim()) throw new Error("Chat stream was interrupted")
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Keeps one stream alive until the view closes, recovering history after disconnections. */
export async function watchChatStream(
  url: string,
  options: {
    signal: AbortSignal
    fetcher?: typeof fetch
    onSnapshot: (value: unknown) => void
    onError: (message: string) => void
  }
): Promise<void> {
  let failures = 0
  while (!options.signal.aborted) {
    const controller = new AbortController()
    /** Cancels only this HTTP connection when its owning view closes. */
    const abort = () => controller.abort()
    options.signal.addEventListener("abort", abort, { once: true })
    // Heartbeats arrive every ten seconds; a dead connection must not remain silent forever.
    let timeout = setTimeout(abort, 30_000)
    try {
      const response = await (options.fetcher ?? fetch)(url, {
        signal: controller.signal,
        cache: "no-store",
      })
      if (!response.ok || !response.body)
        throw new Error("Could not load chat. Reconnecting…")
      await readChatStream(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, output) {
              clearTimeout(timeout)
              timeout = setTimeout(abort, 30_000)
              output.enqueue(chunk)
            },
          })
        ),
        (value) => {
          if (options.signal.aborted) return
          if (value && typeof value === "object" && "error" in value)
            throw new Error("Could not load chat. Reconnecting…")
          options.onSnapshot(value)
          failures = 0
        }
      )
    } catch {
      if (!options.signal.aborted) {
        failures += 1
        options.onError("Connection lost. Reconnecting…")
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
      options.signal.removeEventListener("abort", abort)
    }
    if (options.signal.aborted) return
    await new Promise<void>((resolve) => {
      /** Clears the reconnect timer promptly on view dismissal. */
      const finish = () => {
        clearTimeout(timer)
        options.signal.removeEventListener("abort", finish)
        resolve()
      }
      const timer = setTimeout(
        finish,
        failures ? Math.min(5000, 500 * 2 ** Math.min(failures, 4)) : 100
      )
      options.signal.addEventListener("abort", finish, { once: true })
    })
  }
}
