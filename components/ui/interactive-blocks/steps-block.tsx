"use client"

/**
 * Renders a worked example from a ```steps Markdown block, revealed one step at a time.
 *
 * The first step is visible immediately so the learner can attempt the next one before revealing it.
 * Revealing a step moves keyboard focus to it so screen reader and keyboard users land on new content.
 */
import { useEffect, useId, useRef, useState } from "react"
import type { StepsBlock } from "@/lib/interactive-blocks"
import { Button } from "@/components/ui/button"
import type { MarkdownRenderer } from "@/components/ui/interactive-blocks/context"

/**
 * Renders one progressively revealed worked example.
 * @param block Validated steps block.
 * @param renderMarkdown Renders step bodies as non-interactive Markdown.
 * @returns The revealed steps and actions to reveal the next or all remaining steps.
 */
export function StepsBlockView({
  block,
  renderMarkdown,
}: {
  block: StepsBlock
  renderMarkdown: MarkdownRenderer
}) {
  const headingId = useId()
  const [revealed, setRevealed] = useState(1)
  const stepRefs = useRef<Array<HTMLLIElement | null>>([])
  // Set only by explicit reveals so the first render never steals focus.
  const focusStep = useRef<number | null>(null)
  const total = block.steps.length
  const shown = Math.min(revealed, total)

  useEffect(() => {
    if (focusStep.current === null) return
    stepRefs.current[focusStep.current]?.focus()
    focusStep.current = null
  }, [shown])

  /**
   * Reveals steps up to a count and focuses the first newly revealed step.
   * @param count Number of steps to show.
   */
  function reveal(count: number) {
    focusStep.current = shown
    setRevealed(Math.min(count, total))
  }

  return (
    <section
      className="interactive-block rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-labelledby={headingId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p id={headingId} className="font-medium">
          {block.title ?? "Worked example"}
        </p>
        <p className="text-xs text-muted-foreground">
          Step {shown} of {total}
        </p>
      </div>

      <ol className="interactive-steps mt-3">
        {block.steps.slice(0, shown).map((step, index) => (
          <li
            key={index}
            ref={(element) => {
              stepRefs.current[index] = element
            }}
            tabIndex={-1}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
          >
            <span className="flex size-7 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">
              <span className="sr-only">Step </span>
              {index + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              {step.title ? <p className="font-medium">{step.title}</p> : null}
              <div className={step.title ? "mt-1" : undefined}>
                {renderMarkdown(step.body)}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {shown < total ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            className="h-11 px-4 sm:h-9"
            onClick={() => reveal(shown + 1)}
          >
            Show next step
          </Button>
          {total - shown > 1 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-4 sm:h-9"
              onClick={() => reveal(total)}
            >
              Show all steps
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
