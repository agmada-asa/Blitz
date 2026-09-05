/** Verifies native feed swipe intent thresholds and direction filtering. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  clampFeedIndex,
  chooseFeedDelta,
  feedSwipeDirection,
  isFeedAdvanceGesture,
} from "../lib/gesture.ts"

test("accepts a comfortable vertical drag and quick flick", () => {
  assert.equal(
    isFeedAdvanceGesture({ deltaX: 4, deltaY: 90, velocityY: 0, height: 800 }),
    true
  )
  assert.equal(
    isFeedAdvanceGesture({ deltaX: 2, deltaY: 30, velocityY: 0, height: 800 }),
    true
  )
  assert.equal(
    isFeedAdvanceGesture({ deltaX: 2, deltaY: 4, velocityY: 0.6, height: 800 }),
    true
  )
  assert.equal(feedSwipeDirection(0, -0.6), -1)
  assert.equal(chooseFeedDelta(29.3, 8.2), 29.3)
})

test("rejects taps and horizontal gestures", () => {
  assert.equal(
    isFeedAdvanceGesture({ deltaX: 2, deltaY: 20, velocityY: 0, height: 800 }),
    false
  )
  assert.equal(
    isFeedAdvanceGesture({
      deltaX: 100,
      deltaY: 60,
      velocityY: 0.8,
      height: 800,
    }),
    false
  )
  assert.equal(clampFeedIndex(4, 3), 2)
  assert.equal(clampFeedIndex(-1, 3), 0)
})
