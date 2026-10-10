"use client"

/**
 * Shows a Teach session's lesson outline: which sections are done, which one
 * is being taught, and which are still ahead. Used as a side rail on wide
 * screens and inside a popover on narrow ones.
 */

import { CheckIcon } from "@/components/ui/icon"
import type { TeachOutline } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Outline plus the learner's position and navigation callbacks. */
export type TeachOutlineProps = {
  outline: TeachOutline
  /** Zero-based section being taught; equal to the section count when complete. */
  sectionIndex: number
  /** Sections actually taught; others can be jumped to even if earlier. */
  taughtSectionIds: ReadonlySet<string>
  /** Disables jumping ahead while a reply is being written. */
  busy: boolean
  /** Scrolls to a section already taught. */
  onOpenSection: (index: number) => void
  /** Asks the tutor to teach a section not yet reached. */
  onJumpToSection: (index: number) => void
}

/**
 * Renders the outline as an ordered list of section buttons.
 *
 * Taught sections scroll to their place in the lesson. Sections not taught yet,
 * including ones skipped by jumping ahead, ask the tutor to teach them, which
 * is disabled while a reply is in progress.
 */
export function TeachOutlineList({
  outline,
  sectionIndex,
  taughtSectionIds,
  busy,
  onOpenSection,
  onJumpToSection,
}: TeachOutlineProps) {
  return (
    <ol className="space-y-1">
      {outline.sections.map((section, index) => {
        const state =
          index === sectionIndex
            ? "current"
            : taughtSectionIds.has(section.id)
              ? "done"
              : "ahead"
        // Only taught sections have a place in the lesson to scroll to.
        const reached = state !== "ahead"
        return (
          <li key={section.id}>
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
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                  state === "done" && "border-brand bg-brand text-brand-foreground",
                  state === "current" && "border-brand text-brand",
                  state === "ahead" && "border-border"
                )}
              >
                {state === "done" ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {section.title}
                <span className="sr-only">
                  {state === "done"
                    ? " (done)"
                    : state === "current"
                      ? " (current)"
                      : " (not started)"}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
