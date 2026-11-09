"use client"

/**
 * The bottom of the Teach screen: one bar, as wide as the lesson's text, that
 * moves the lesson along. It says `Next section` while the lesson waits for
 * the learner and shows a disabled spinner while the tutor works. After the
 * opening pre-check it offers to plan the lesson around the answers or skip
 * the check; after the recap it offers practice and the next unit. N sends the
 * next section from the keyboard. Questions go to the side chat instead, which
 * leaves the lesson undisturbed, and Pause is in Unit options.
 */

import Link from "next/link"
import { useEffect, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { ArrowRightIcon, LoadingIcon } from "@/components/ui/icon"
import { isTypingTarget } from "@/hooks/use-quiz-shortcuts"
import { TEACH_QUICK_REPLIES } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** What the dock should offer for the session's current state. */
export type TeachDockState =
  | { kind: "no-material" }
  | { kind: "starting" }
  | { kind: "writing" }
  /** Compact now is running; nothing can be sent until it finishes. */
  | { kind: "compacting" }
  /** A lesson update is revising the outline; nothing can be sent until it finishes. */
  | { kind: "updating" }
  | { kind: "paused"; hasText: boolean }
  /** The opening check is on screen; `answered` counts its answered quizzes. */
  | { kind: "precheck"; answered: number }
  | { kind: "ready"; isLastSection: boolean }
  | {
      kind: "complete"
      practiceHref: string
      nextUnit: { href: string; title: string } | null
    }

/** Props for the dock. */
type TeachDockProps = {
  state: TeachDockState
  error: string
  onSend: (message: string) => void
  onResume: () => void
}

/** Shape of the dock's main bar, and of any button sharing the row with it. */
const BAR_CLASS = "min-h-12 rounded-full text-[15px]"

/** The main bar's colours. */
const PRIMARY_BAR_CLASS = `${BAR_CLASS} min-w-0 flex-1 bg-brand px-5 text-brand-foreground hover:bg-brand/85`

/** Renders the lesson's current action as a single bar. */
export function TeachDock({ state, error, onSend, onResume }: TeachDockProps) {
  const ready = state.kind === "ready"

  // While the lesson waits for the learner, N sends "Next section" unless they are typing or hold a modifier.
  useEffect(() => {
    if (!ready) return
    const onKeyDown = (event: WindowEventMap["keydown"]) => {
      if (event.key.toLowerCase() !== "n") return
      if (event.repeat || event.isComposing || event.defaultPrevented) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        return
      if (isTypingTarget(event.target)) return
      // A dialog such as the session summary takes the keyboard; N belongs to it.
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]')
      )
        return
      onSend(TEACH_QUICK_REPLIES.next)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [ready, onSend])

  if (state.kind === "no-material" && !error) return null

  /** Chooses the bar for the session's current state. */
  function bar(): ReactNode {
    switch (state.kind) {
      case "no-material":
        return null
      case "complete":
        return (
          <div className="flex gap-2">
            <Button asChild className={PRIMARY_BAR_CLASS}>
              <Link href={state.practiceHref}>Practice this unit</Link>
            </Button>
            {state.nextUnit ? (
              <Button
                asChild
                variant="outline"
                className={cn(BAR_CLASS, "min-w-0 flex-1 px-5")}
              >
                <Link href={state.nextUnit.href}>
                  <span className="truncate">Next: {state.nextUnit.title}</span>
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </div>
        )
      case "precheck":
        return (
          <>
            <p className="mb-2 text-center text-sm text-muted-foreground" role="status">
              {state.answered
                ? `${state.answered} answered. Anything you leave gets taught.`
                : "Answer what you can. Anything you leave gets taught."}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => onSend(TEACH_QUICK_REPLIES.precheckDone)}
                className={PRIMARY_BAR_CLASS}
              >
                Plan my lesson
                <ArrowRightIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onSend(TEACH_QUICK_REPLIES.skipPrecheck)}
                className={cn(BAR_CLASS, "shrink-0 px-5")}
              >
                Skip the check
              </Button>
            </div>
          </>
        )
      case "ready":
        return (
          <div className="flex">
            <Button
              type="button"
              onClick={() => onSend(TEACH_QUICK_REPLIES.next)}
              className={PRIMARY_BAR_CLASS}
            >
              {state.isLastSection ? "Finish unit" : "Next section"}
              <kbd
                aria-hidden="true"
                className="hidden rounded border border-current/25 px-1 font-sans text-[11px] leading-4 font-normal opacity-70 pointer-fine:inline"
              >
                N
              </kbd>
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          </div>
        )
      case "paused":
        return (
          <div className="flex">
            <Button type="button" onClick={onResume} className={PRIMARY_BAR_CLASS}>
              {state.hasText ? "Continue writing" : "Try again"}
            </Button>
          </div>
        )
      default:
        return (
          <div className="flex">
            <Button type="button" disabled className={PRIMARY_BAR_CLASS}>
              <LoadingIcon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              <span role="status">
                {state.kind === "starting"
                  ? "Preparing your lesson…"
                  : state.kind === "compacting"
                    ? "Compacting the session…"
                    : state.kind === "updating"
                      ? "Updating the lesson…"
                      : "Working…"}
              </span>
            </Button>
          </div>
        )
    }
  }

  return (
    // The same width and padding as the lesson column, so the bar lines up with its text.
    <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {bar()}
    </div>
  )
}
