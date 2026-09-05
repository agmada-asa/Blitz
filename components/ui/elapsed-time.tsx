"use client"

/** Shows a live elapsed duration without announcing every tick to screen readers. */

import { useEffect, useState } from "react"

/** Formats the known duration of a queued or running job, without predicting completion. */
export function ElapsedTime({ since }: { since: number }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [])
  const seconds =
    now === null ? null : Math.max(0, Math.floor((now - since) / 1_000))
  const duration =
    seconds === null
      ? "…"
      : seconds < 60
        ? `${seconds}s`
        : seconds < 3_600
          ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
          : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
  return (
    <span
      className="tabular-nums"
      aria-label={
        seconds === null ? "Loading elapsed time" : `${seconds} seconds elapsed`
      }
    >
      {duration}
    </span>
  )
}
