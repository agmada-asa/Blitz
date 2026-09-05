/** Defines the small, direction-aware swipe intent used by the native feed pager. */

/** Returns true for an intentional vertical page gesture, excluding taps and horizontal drags. */
export function isFeedAdvanceGesture(input: {
  readonly deltaX: number
  readonly deltaY: number
  readonly velocityY: number
  readonly height: number
}): boolean {
  const verticalDistance = Math.abs(input.deltaY)
  const horizontalDistance = Math.abs(input.deltaX)
  const verticalDominant = verticalDistance >= horizontalDistance
  const distanceThreshold = Math.min(48, Math.max(24, input.height * 0.03))
  const quickFlick =
    Math.abs(input.velocityY) >= 0.45 &&
    verticalDistance >= 4 &&
    verticalDominant
  return (
    verticalDominant && (verticalDistance >= distanceThreshold || quickFlick)
  )
}

/** Returns the one-card direction implied by a recognized vertical gesture. */
export function feedSwipeDirection(deltaY: number, velocityY: number): -1 | 1 {
  return (Math.abs(deltaY) >= 4 ? deltaY : velocityY) >= 0 ? 1 : -1
}

/** Clamps a swipe target to the available feed page range. */
export function clampFeedIndex(index: number, cardCount: number): number {
  return Math.max(0, Math.min(Math.max(0, cardCount - 1), index))
}

/** Chooses the strongest available vertical displacement when Android splits touch delivery. */
export function chooseFeedDelta(
  nativeDeltaY: number,
  touchDeltaY: number
): number {
  return Math.abs(touchDeltaY) >= Math.abs(nativeDeltaY)
    ? touchDeltaY
    : nativeDeltaY
}
