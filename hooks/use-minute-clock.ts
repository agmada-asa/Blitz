"use client"

/**
 * Provides the current time rounded down to the minute, updating every
 * minute. Convex queries take it as an argument so results that depend on the
 * time (due reviews, today's XP) refresh as time passes without re-running on
 * every render.
 */

import { useEffect, useState } from "react"

/** Rounds a timestamp down to the start of its minute. */
function minute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000
}

/** Returns the current minute as a timestamp and re-renders when it changes. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => minute(Date.now()))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(minute(Date.now())), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
