/** Relays live Convex conversation snapshots to web and native HTTP clients. */
import { ConvexClient } from "convex/browser"
import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"

/** Opens a bounded-lifetime NDJSON subscription; closing the view never cancels generation. */
export function chatStream(
  endpoint: string,
  args: { projectId: Id<"projects">; itemId: Id<"learningItems"> },
  signal: AbortSignal
): Response {
  const client = new ConvexClient(endpoint, { unsavedChangesWarning: false })
  const encoder = new TextEncoder()
  let cleanup = () => {}
  let latest: string | undefined
  let pump = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      /** Releases the socket, timers, and abort listener exactly once. */
      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        clearTimeout(deadline)
        signal.removeEventListener("abort", cleanup)
        void client.close().catch(() => undefined)
        try {
          controller.close()
        } catch {
          /* The reader may already have cancelled. */
        }
      }
      /** Coalesces slow-reader updates instead of buffering unbounded chat history. */
      pump = () => {
        if (
          !closed &&
          latest !== undefined &&
          (controller.desiredSize ?? 0) > 0
        ) {
          controller.enqueue(encoder.encode(latest))
          latest = undefined
        }
      }
      const heartbeat = setInterval(() => {
        if (latest === undefined) latest = "\n"
        pump()
      }, 10_000)
      const deadline = setTimeout(cleanup, 60_000)
      signal.addEventListener("abort", cleanup, { once: true })
      if (signal.aborted) {
        cleanup()
        return
      }
      client.onUpdate(
        api.conversations.get,
        args,
        (snapshot) => {
          latest = `${JSON.stringify(snapshot)}\n`
          pump()
        },
        () => {
          if (!closed) {
            controller.enqueue(
              encoder.encode('{"error":"Could not load chat. Reconnecting…"}\n')
            )
            cleanup()
          }
        }
      )
    },
    pull() {
      pump()
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
