"use client"

/**
 * Shows a Teach session's lesson outline: which sections are done, which one
 * is being taught, and which are still ahead. The list is drawn as a path and
 * used as a side rail on wide screens and inside a popover on narrow ones;
 * the segmented bar sits in the header on every screen.
 */

import {
  PathConnector,
  PathMarker,
  SegmentedBar,
  pathSegments,
  pathStateLabel,
  type PathState,
} from "@/components/progress/progress-path"
import type { TeachOutline, TeachSectionMode, TeachSectionPlan } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Outline plus the learner's position and navigation callbacks. */
export type TeachOutlineProps = {
  outline: TeachOutline
  /** Zero-based section being taught; equal to the section count when complete. */
  sectionIndex: number
  /** Sections actually taught; others can be jumped to even if earlier. */
  taughtSectionIds: ReadonlySet<string>
  /** Skip, skim, or teach per section from the pre-check, once agreed. */
  plan?: TeachSectionPlan | null
  /** Disables jumping ahead while a reply is being written. */
  busy: boolean
  /** Scrolls to a section already taught. */
  onOpenSection: (index: number) => void
  /** Asks the tutor to teach a section not yet reached. */
  onJumpToSection: (index: number) => void
}

/**
 * Returns a section's state from the learner's position and taught sections.
 * A section the pre-check showed the learner already knows counts as done.
 */
function sectionState(
  index: number,
  sectionIndex: number,
  taught: boolean,
  mode?: TeachSectionMode
): PathState {
  if (index === sectionIndex) return "current"
  return taught || mode === "skip" ? "done" : "ahead"
}

/** Looks up a section's planned mode, if a plan exists. */
function modeOf(plan: TeachSectionPlan | null | undefined, id: string) {
  return plan?.find((entry) => entry.id === id)?.mode
}

/** Short labels shown beside sections the pre-check changed. */
const MODE_LABELS: Partial<Record<TeachSectionMode, string>> = {
  skip: "Known",
  skim: "Quick",
}

/**
 * Shows progress through the unit as one segment per section: filled when
 * taught, half filled for the current section, empty when still ahead.
 * Decorative; callers give the progress in text alongside it.
 */
export function TeachProgressBar({
  outline,
  sectionIndex,
  taughtSectionIds,
  plan,
  className,
}: Pick<TeachOutlineProps, "outline" | "sectionIndex" | "taughtSectionIds" | "plan"> & {
  className?: string
}) {
  return (
    <SegmentedBar
      className={className}
      segments={pathSegments(
        outline.sections.map((section, index) => ({
          key: section.id,
          state: sectionState(
            index,
            sectionIndex,
            taughtSectionIds.has(section.id),
            modeOf(plan, section.id)
          ),
        }))
      )}
    />
  )
}

/**
 * Renders the outline as an ordered list of section buttons joined by a path.
 *
 * Taught sections scroll to their place in the lesson. Sections not taught yet,
 * including ones skipped by jumping ahead, ask the tutor to teach them, which
 * is disabled while a reply is in progress.
 */
export function TeachOutlineList({
  outline,
  sectionIndex,
  taughtSectionIds,
  plan,
  busy,
  onOpenSection,
  onJumpToSection,
}: TeachOutlineProps) {
  return (
    <ol className="space-y-1">
      {outline.sections.map((section, index) => {
        const mode = modeOf(plan, section.id)
        const taught = taughtSectionIds.has(section.id)
        const state = sectionState(index, sectionIndex, taught, mode)
        const label = taught ? undefined : mode && MODE_LABELS[mode]
        // Only taught sections have a place in the lesson to scroll to; a
        // known section the tutor skipped is taught in full when chosen.
        const reached = state === "current" || taught
        const last = index === outline.sections.length - 1
        return (
          <li key={section.id} className="relative">
            {/* The path joins each section's marker to the next; taught stretches are filled. */}
            {!last ? (
              <PathConnector
                done={state === "done"}
                className="top-[34px] -bottom-[14px] left-[21.5px]"
              />
            ) : null}
            <button
              type="button"
              disabled={!reached && busy}
              aria-current={state === "current" ? "step" : undefined}
              onClick={() =>
                reached ? onOpenSection(index) : onJumpToSection(index)
              }
              className={cn(
                "flex min-h-11 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                state === "current" && "bg-brand/10 text-foreground",
                state === "ahead" && "text-muted-foreground"
              )}
            >
              <PathMarker state={state} number={index + 1} className="mt-0.5" />
              <span className="min-w-0 flex-1 break-words">
                {section.title}
                <span className="sr-only"> ({pathStateLabel(state)})</span>
                {label ? (
                  <span className="ml-2 inline-block rounded-full bg-muted px-2 py-px align-[1px] text-[11px] text-muted-foreground">
                    {label}
                    <span className="sr-only">
                      {mode === "skip" ? ": the check showed you know this" : ": taught briefly"}
                    </span>
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
