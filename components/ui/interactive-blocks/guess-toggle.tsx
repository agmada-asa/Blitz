"use client"

/**
 * The "I'm guessing" switch shown beside a question before it is answered.
 * A right answer marked as a guess is weaker evidence: review scheduling
 * grades it Hard instead of Good, and the Teach pre-check treats it as not
 * yet known. Shared by inline quizzes and Review feed cards.
 */

import { cn } from "@/lib/utils"

/**
 * Renders a pressed or unpressed toggle button.
 * @param pressed Whether the learner has marked the coming answer as a guess.
 * @param onPressedChange Called with the new state when the learner taps it.
 */
export function GuessToggle({
  pressed,
  onPressedChange,
  className,
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center rounded-full border px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        pressed
          ? "border-brand/50 bg-brand/10 font-medium text-brand"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        className
      )}
    >
      I&apos;m guessing
    </button>
  )
}
