/**
 * The progress visuals the Teach screen introduced, shared by every screen
 * that shows a learner's way through material: a segmented bar (one segment
 * per section, unit, or concept) and a path of numbered markers joined by a
 * line. Teach's outline, the module page, Practice, the Library, and Home all
 * draw progress with these so the app reads as one system.
 *
 * Both are decorative: callers always state the same progress in text.
 */

import { CheckIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Where one step of a path stands for the learner. */
export type PathState = "done" | "current" | "ahead"

/** One segment of a segmented bar. */
export type BarSegment = {
  /** Stable key for the segment. */
  key: string
  /** How much of the segment is filled, from 0 to 1. */
  fill: number
  /** Fill colour class; the brand colour when omitted. */
  tone?: string
}

/**
 * Shows progress as a row of equal segments, each filled to its own amount.
 * Used for sections in a unit, units in a module, and concepts by strength.
 * @param segments The segments in order; an empty list renders nothing.
 * @param className Extra classes for the row, usually a margin.
 * @param size Bar thickness: `sm` for list rows, `md` for headers.
 */
export function SegmentedBar({
  segments,
  className,
  size = "md",
}: {
  segments: BarSegment[]
  className?: string
  size?: "sm" | "md"
}) {
  if (!segments.length) return null
  return (
    <div
      aria-hidden="true"
      className={cn("flex w-full", segments.length > 24 ? "gap-px" : "gap-1", className)}
    >
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={cn(
            "flex-1 overflow-hidden rounded-full bg-muted",
            size === "sm" ? "h-1" : "h-1.5"
          )}
        >
          <span
            className={cn(
              // Fill and colour ease over 400 ms when a value changes; the first paint has no transition.
              "block h-full rounded-full transition-[width,background-color] duration-400 ease-out motion-reduce:transition-none",
              segment.tone ?? "bg-brand"
            )}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, segment.fill)) * 100)}%` }}
          />
        </span>
      ))}
    </div>
  )
}

/**
 * Converts path states to bar segments: done is full, current is half, and
 * ahead is empty, matching the Teach header.
 * @param steps Each step's key and state, in order.
 */
export function pathSegments(steps: Array<{ key: string; state: PathState }>): BarSegment[] {
  return steps.map(({ key, state }) => ({
    key,
    fill: state === "done" ? 1 : state === "current" ? 0.5 : 0,
  }))
}

/**
 * The round marker for one step of a path: a tick when done, a ringed number
 * when current, and a plain number when ahead.
 * @param state The step's state.
 * @param number The one-based step number shown when not done.
 * @param size `sm` for dense outlines, `md` for list rows.
 */
export function PathMarker({
  state,
  number,
  size = "sm",
  className,
}: {
  state: PathState
  number: number
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border bg-background font-medium tabular-nums",
        size === "sm" ? "size-5 text-[11px]" : "size-8 text-sm",
        state === "done" && "border-brand bg-brand text-brand-foreground",
        state === "current" && "border-2 border-brand text-brand ring-4 ring-brand/15",
        state === "ahead" && "border-border text-muted-foreground",
        className
      )}
    >
      {state === "done" ? <CheckIcon className={size === "sm" ? "size-3" : "size-4"} /> : number}
    </span>
  )
}

/**
 * The line joining one step's marker to the next, filled once the step is
 * done. Place it inside a `relative` list item; `className` positions it so it
 * runs from below this marker to the next one. The colour eases over 400 ms
 * when `done` changes, and the first paint shows the final colour.
 * @param done Whether the step before this line is done.
 * @param className Extra classes that position the line.
 */
export function PathConnector({ done, className }: { done: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute w-px transition-colors duration-400 ease-out motion-reduce:transition-none",
        done ? "bg-brand" : "bg-border",
        className
      )}
    />
  )
}

/** Words for a path state, for screen readers next to a marker. */
export function pathStateLabel(state: PathState): string {
  return state === "done" ? "done" : state === "current" ? "current" : "not started"
}
