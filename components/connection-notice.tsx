"use client"

/**
 * Tells the learner when the browser has lost its live connection to Blitz's
 * local database, which otherwise looks like a frozen or empty app.
 */

import { useEffect, useState } from "react"
import { useConvexConnectionState } from "convex/react"

/** Disconnections shorter than this are ordinary reconnects and stay silent. */
const graceMs = 3_000

/**
 * Renders a small status pill while Convex is unreachable.
 *
 * Shows `Reconnecting` after a lost connection, and a recovery hint when the
 * page has never connected, which usually means Blitz is not running.
 */
export function ConnectionNotice() {
  const { isWebSocketConnected, hasEverConnected } = useConvexConnectionState()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isWebSocketConnected) {
      // Hide on the next frame so the effect never sets state synchronously.
      const frame = window.requestAnimationFrame(() => setVisible(false))
      return () => window.cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(() => setVisible(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [isWebSocketConnected])

  if (!visible) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 top-4 z-50 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-full border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg"
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-brand motion-safe:animate-pulse"
      />
      {hasEverConnected
        ? "Reconnecting to Blitz…"
        : "Can't reach Blitz. Make sure it's running on your Mac."}
    </div>
  )
}
