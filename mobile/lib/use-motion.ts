/** Tracks the device's reduced-motion preference and foreground state for native feed animations. */

import { useEffect, useState } from "react"
import { AccessibilityInfo, AppState } from "react-native"

/** Enables decorative motion only while foregrounded and after the device permits it. */
export function useMotionEnabled(): boolean {
  const [reduced, setReduced] = useState(true)
  const [active, setActive] = useState(AppState.currentState === "active")
  useEffect(() => {
    let mounted = true
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value)
      })
      .catch(() => undefined)
    const motion = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced
    )
    const state = AppState.addEventListener("change", (value) =>
      setActive(value === "active")
    )
    return () => {
      mounted = false
      motion.remove()
      state.remove()
    }
  }, [])
  return active && !reduced
}
