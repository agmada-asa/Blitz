"use client"

/**
 * The two ways into the side chat from inside a lesson. While the learner
 * scrolls or moves the pointer, a faint Blitz mark sits in the margin beside
 * the line being read; hovering turns it accent and highlights the sentence or
 * component it would quote, and pressing it asks about that. Selecting text
 * shows an Ask Blitz button beneath the selection, for anything more precise.
 *
 * Both read the rendered lesson through `lib/client/lesson-passage-dom.ts` and
 * hand the passage to the Teach screen, which opens the side chat with it.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { BlitzLogo } from "@/components/blitz-logo"
import { Button } from "@/components/ui/button"
import {
  passageAtPoint,
  selectedPassage,
  setLessonHighlight,
  type LessonPassage,
} from "@/lib/client/lesson-passage-dom"
import { cn } from "@/lib/utils"

/** How long the mark stays after the last scroll or pointer move. */
const MARK_LINGER_MS = 1_800

/** Width of the mark's button; it stays clear of the lesson text. */
const MARK_SIZE = 32

/** Where the mark reads when no pointer says otherwise, as a share of the view's height. */
const READING_LINE = 0.38

/** Props for the overlay. */
type TeachAskOverlayProps = {
  /** The lesson's scrolling element; the overlay sits in its positioned parent. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** The column holding the lesson text. */
  columnRef: RefObject<HTMLDivElement | null>
  /** The passage already quoted in the side chat, kept highlighted. */
  heldRange?: Range
  /** Opens the side chat with a passage. */
  onAsk: (passage: LessonPassage) => void
}

/**
 * Renders the margin mark and the selection button over the lesson.
 * Renders nothing visible until the learner scrolls, points, or selects.
 */
export function TeachAskOverlay({
  scrollRef,
  columnRef,
  heldRange,
  onAsk,
}: TeachAskOverlayProps) {
  const [mark, setMark] = useState<{ left: number; top: number } | null>(null)
  const [markAwake, setMarkAwake] = useState(false)
  const [markActive, setMarkActive] = useState(false)
  const [selection, setSelection] = useState<{
    passage: LessonPassage
    left: number
    top: number
  } | null>(null)
  const targetRef = useRef<LessonPassage | null>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const markActiveRef = useRef(false)
  const frameRef = useRef<number | undefined>(undefined)
  const lingerRef = useRef<number | undefined>(undefined)

  /** Re-reads which line the mark belongs to and moves it there. */
  const place = useCallback(() => {
    frameRef.current = undefined
    const scroller = scrollRef.current
    const column = columnRef.current
    const frame = scroller?.parentElement
    // Pressing or hovering the mark must not change what it would quote.
    if (!scroller || !column || !frame || markActiveRef.current) return
    const columnBox = column.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    const styles = getComputedStyle(column)
    const textLeft = columnBox.left + parseFloat(styles.paddingLeft)
    const textRight = columnBox.right - parseFloat(styles.paddingRight)
    const pointer = pointerRef.current
    // The pointer sets the line while it is over the lesson; its height still
    // counts out in the margin, so the mark comes to meet it.
    const y = pointer?.y ?? frameBox.top + frameBox.height * READING_LINE
    const x = Math.max(textLeft + 4, Math.min(pointer?.x ?? textLeft + 4, textRight - 4))
    const found = passageAtPoint(column, x, y)
    if (!found) return
    targetRef.current = found
    setMark({
      left: Math.min(
        textRight - frameBox.left + 6,
        frameBox.width - MARK_SIZE - 2
      ),
      top: found.lineCenter - frameBox.top - MARK_SIZE / 2,
    })
  }, [scrollRef, columnRef])

  /** Shows the mark for a while and places it on the next frame. */
  const wake = useCallback(() => {
    frameRef.current ??= requestAnimationFrame(place)
    setMarkAwake(true)
    window.clearTimeout(lingerRef.current)
    lingerRef.current = window.setTimeout(() => {
      if (!markActiveRef.current) setMarkAwake(false)
    }, MARK_LINGER_MS)
  }, [place])

  // The learner's activity over the lesson wakes the mark. A touch has no
  // pointer position to follow, so the mark reads at the reading line.
  useEffect(() => {
    const scroller = scrollRef.current
    const frame = scroller?.parentElement
    if (!scroller || !frame) return
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return
      pointerRef.current = { x: event.clientX, y: event.clientY }
      wake()
    }
    const onPointerLeave = () => {
      pointerRef.current = null
    }
    scroller.addEventListener("scroll", wake, { passive: true })
    frame.addEventListener("pointermove", onPointerMove, { passive: true })
    frame.addEventListener("pointerleave", onPointerLeave)
    return () => {
      scroller.removeEventListener("scroll", wake)
      frame.removeEventListener("pointermove", onPointerMove)
      frame.removeEventListener("pointerleave", onPointerLeave)
      window.clearTimeout(lingerRef.current)
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
      frameRef.current = undefined
    }
  }, [scrollRef, wake])

  /** Tracks the selection and where its button goes. */
  const readSelection = useCallback(() => {
    const column = columnRef.current
    const frame = scrollRef.current?.parentElement
    if (!column || !frame) return
    const passage = selectedPassage(column)
    const last = passage
      ? Array.from(passage.range.getClientRects())
          .filter((rect) => rect.width > 0)
          .at(-1)
      : undefined
    if (!passage || !last) {
      setSelection(null)
      return
    }
    const box = frame.getBoundingClientRect()
    const buttonWidth = 112
    setSelection({
      passage,
      left: Math.max(
        8,
        Math.min(last.right - box.left - buttonWidth / 2, box.width - buttonWidth - 8)
      ),
      top: Math.min(last.bottom - box.top + 6, box.height - 44),
    })
  }, [columnRef, scrollRef])

  // A selection is read once it settles, so its button doesn't chase the drag.
  useEffect(() => {
    const scroller = scrollRef.current
    let timer: number | undefined
    /** Reads the selection after a short pause. */
    const settle = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(readSelection, 120)
    }
    document.addEventListener("selectionchange", settle)
    scroller?.addEventListener("scroll", readSelection, { passive: true })
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("selectionchange", settle)
      scroller?.removeEventListener("scroll", readSelection)
    }
  }, [readSelection, scrollRef])

  // Hovering shows what the mark would quote; otherwise what's already quoted.
  useEffect(() => {
    setLessonHighlight(
      markActive ? (targetRef.current?.range ?? null) : (heldRange ?? null)
    )
    return () => setLessonHighlight(null)
  }, [markActive, heldRange])

  /** Marks the control as hovered or focused, which holds its target still. */
  function setActive(active: boolean) {
    markActiveRef.current = active
    setMarkActive(active)
    // Leaving it starts the same fade as any other pause.
    if (!active) wake()
  }

  return (
    <>
      {mark && !selection ? (
        <button
          type="button"
          aria-label="Ask Blitz about this line"
          title="Ask Blitz about this"
          tabIndex={markAwake ? 0 : -1}
          style={{ left: mark.left, top: mark.top, width: MARK_SIZE, height: MARK_SIZE }}
          onPointerEnter={() => setActive(true)}
          onPointerLeave={() => setActive(false)}
          onFocus={() => setActive(true)}
          onBlur={() => setActive(false)}
          onClick={() => {
            if (!targetRef.current) return
            onAsk(targetRef.current)
            setActive(false)
          }}
          className={cn(
            "absolute z-10 flex items-center justify-center rounded-full text-muted-foreground/45 transition-[opacity,color] duration-150 hover:text-brand focus-visible:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
            markAwake || markActive ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          <BlitzLogo size={17} mono />
        </button>
      ) : null}
      {selection ? (
        <Button
          type="button"
          size="sm"
          style={{ left: selection.left, top: selection.top }}
          // Pressing must not clear the selection before it's read.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onAsk(selection.passage)
            window.getSelection()?.removeAllRanges()
            setSelection(null)
          }}
          className="absolute z-20 gap-1.5 rounded-full bg-brand text-brand-foreground shadow-md hover:bg-brand/85"
        >
          <BlitzLogo size={14} mono />
          Ask Blitz
        </Button>
      ) : null}
    </>
  )
}
