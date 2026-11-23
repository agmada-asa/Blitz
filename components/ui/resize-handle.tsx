"use client"

/**
 * A drag handle for the left edge of a right-hand side pane. Dragging it, or
 * using the arrow keys while it has focus, changes the pane's width; a double
 * click or Enter returns the pane to its default width.
 *
 * The handle measures the pane it sits in, so it must be a direct child of
 * that pane, and the pane must be positioned (`relative`). The caller owns the
 * width: `onResize` fires on every step and `onResizeEnd` once a drag or key
 * press settles, which is the moment to save it.
 */

import * as React from "react"

import { cn } from "@/lib/utils"

/** Pixels one arrow key press moves the edge; Shift moves it four times as far. */
const KEY_STEP = 16

/** Props for the side pane's resize handle. */
type ResizeHandleProps = {
  /** Accessible name, such as "Resize Ask Blitz". */
  label: string
  /** Narrowest width in CSS pixels. */
  min: number
  /** Widest width in CSS pixels, or a function read at each step so it follows the window size. */
  max: number | (() => number)
  /** Shows a new width while the edge moves. */
  onResize: (width: number) => void
  /** Called with the final width when a drag or key press ends. */
  onResizeEnd: (width: number) => void
  /** Returns the pane to its default width. Omit to turn off double click and Enter. */
  onReset?: () => void
  /** Extra classes for positioning in unusual layouts. */
  className?: string
}

/** Renders a focusable vertical separator that resizes its parent pane from the left edge. */
export function ResizeHandle({
  label,
  min,
  max,
  onResize,
  onResizeEnd,
  onReset,
  className,
}: ResizeHandleProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{
    pointerId: number
    startX: number
    startWidth: number
    width: number
  } | null>(null)
  const [paneWidth, setPaneWidth] = React.useState<number | null>(null)
  const [dragging, setDragging] = React.useState(false)

  // Follow the pane's rendered width so screen readers hear the current value.
  React.useEffect(() => {
    const pane = ref.current?.parentElement
    if (!pane) return
    const observer = new ResizeObserver(() =>
      setPaneWidth(Math.round(pane.getBoundingClientRect().width))
    )
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  /** Reads the current upper bound, never letting it fall below `min`. */
  const upperBound = (): number =>
    Math.max(min, typeof max === "function" ? max() : max)

  /** Keeps a width between `min` and the current upper bound. */
  const clamp = (width: number): number =>
    Math.round(Math.min(Math.max(width, min), upperBound()))

  /** Measures the pane as it is drawn now, whatever set its width. */
  const measure = (): number =>
    ref.current?.parentElement?.getBoundingClientRect().width ?? min

  /** Ends a drag, restoring text selection and reporting the final width. */
  const finishDrag = (): void => {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    document.body.style.removeProperty("user-select")
    onResizeEnd(current.width)
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      // The width is only measured in the browser, so the bounds are read there too.
      aria-valuemax={
        paneWidth === null ? undefined : Math.max(paneWidth, upperBound())
      }
      aria-valuenow={paneWidth ?? undefined}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={cn(
        // A 12px hit area centred on the pane's border, with a thin line that
        // shows on hover, focus and while dragging.
        "absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none select-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-transparent after:transition-colors motion-reduce:after:transition-none",
        "hover:after:bg-ring/60 focus-visible:after:bg-ring data-[dragging]:after:bg-ring",
        className
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        // Stops the drag from selecting the lesson text it passes over.
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const startWidth = measure()
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth,
          width: Math.round(startWidth),
        }
        setDragging(true)
        document.body.style.userSelect = "none"
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        // The handle is on the left edge, so moving left widens the pane.
        const width = clamp(current.startWidth + current.startX - event.clientX)
        if (width === current.width) return
        current.width = width
        onResize(width)
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP
        let width: number | null = null
        if (event.key === "ArrowLeft") width = clamp(measure() + step)
        else if (event.key === "ArrowRight") width = clamp(measure() - step)
        else if (event.key === "Home") width = min
        else if (event.key === "End") width = upperBound()
        else if (event.key === "Enter" && onReset) {
          event.preventDefault()
          onReset()
          return
        }
        if (width === null) return
        event.preventDefault()
        onResize(width)
        onResizeEnd(width)
      }}
    />
  )
}
