"use client"

/**
 * The bottom of the Teach screen: one-tap replies that move the lesson along,
 * a box for the learner's own questions, and pause or resume controls while
 * the tutor is writing. After the opening pre-check it offers to plan the
 * lesson around the answers or skip the check; after the recap it offers
 * practice and the next unit. N sends the next section from the keyboard
 * while the lesson waits for the learner. The mic beside the question box
 * turns a spoken question into text to send or edit (`teach-voice.tsx`).
 */

import Link from "next/link"
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"

import { Button } from "@/components/ui/button"
import { ArrowRightIcon, SendIcon } from "@/components/ui/icon"
import { Textarea } from "@/components/ui/textarea"
import { isTypingTarget } from "@/hooks/use-quiz-shortcuts"
import { TEACH_QUICK_REPLIES } from "@/lib/teach"
import {
  DictationButton,
  DictationStatus,
  useDictation,
} from "@/components/learn/teach-voice"

/** What the dock should offer for the session's current state. */
export type TeachDockState =
  | { kind: "no-material" }
  | { kind: "starting" }
  | { kind: "writing" }
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
  onPause: () => void
  onResume: () => void
}

/** Secondary quick replies, in the order learners reach for them. */
const SECONDARY_REPLIES = [
  { label: "Another example", message: TEACH_QUICK_REPLIES.example },
  { label: "Go deeper", message: TEACH_QUICK_REPLIES.deeper },
  { label: "I don't get it", message: TEACH_QUICK_REPLIES.confused },
] as const

/**
 * Renders quick replies and the question box. `Next section` is the primary
 * action; the other replies and the question box are visibly secondary.
 */
export function TeachDock({
  state,
  error,
  onSend,
  onPause,
  onResume,
}: TeachDockProps) {
  const [draft, setDraft] = useState("")
  const canAsk = state.kind === "ready" || state.kind === "complete"
  // A spoken question joins whatever is already typed, ready to edit or send.
  const dictation = useDictation(
    useCallback(
      (text: string) =>
        setDraft((current) => (current.trim() ? `${current.trim()} ${text}` : text)),
      []
    )
  )
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

  /** Sends the typed question and clears the box. */
  function submit(event?: FormEvent) {
    event?.preventDefault()
    const message = draft.trim()
    if (!message || !canAsk) return
    onSend(message)
    setDraft("")
  }

  /** Sends on Enter; Shift+Enter keeps a newline. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="border-t border-border/70 bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {state.kind === "no-material" ? null : state.kind === "complete" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              asChild
              className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              <Link href={state.practiceHref}>Practice this unit</Link>
            </Button>
            {state.nextUnit ? (
              <Button
                asChild
                variant="outline"
                className="min-h-11 rounded-full px-5"
              >
                <Link href={state.nextUnit.href}>
                  Next: {state.nextUnit.title}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </div>
        ) : state.kind === "precheck" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => onSend(TEACH_QUICK_REPLIES.precheckDone)}
              className="min-h-11 shrink-0 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              Plan my lesson
              <ArrowRightIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onSend(TEACH_QUICK_REPLIES.skipPrecheck)}
              className="min-h-11 shrink-0 rounded-full px-4"
            >
              Skip the check
            </Button>
            <p className="text-sm text-muted-foreground" role="status">
              {state.answered
                ? `${state.answered} answered. Anything you leave gets taught.`
                : "Answer what you can. Anything you leave gets taught."}
            </p>
          </div>
        ) : state.kind === "ready" ? (
          <div className="-mx-1 flex [scrollbar-width:none] gap-2 overflow-x-auto px-1 pb-0.5">
            <Button
              type="button"
              onClick={() => onSend(TEACH_QUICK_REPLIES.next)}
              className="min-h-11 shrink-0 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
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
            {SECONDARY_REPLIES.map((reply) => (
              <Button
                key={reply.label}
                type="button"
                variant="outline"
                onClick={() => onSend(reply.message)}
                className="min-h-11 shrink-0 rounded-full px-4"
              >
                {reply.label}
              </Button>
            ))}
          </div>
        ) : state.kind === "paused" ? (
          <Button
            type="button"
            onClick={onResume}
            className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
          >
            {state.hasText ? "Continue writing" : "Try again"}
          </Button>
        ) : (
          <div className="flex min-h-11 items-center justify-between gap-3">
            <p role="status" className="text-sm text-muted-foreground">
              {state.kind === "starting"
                ? "Preparing your lesson…"
                : "Writing…"}
            </p>
            {state.kind === "writing" ? (
              <Button
                type="button"
                variant="outline"
                onClick={onPause}
                className="min-h-11 rounded-full px-4"
              >
                Pause
              </Button>
            ) : null}
          </div>
        )}

        {state.kind === "no-material" ? null : (
          <form onSubmit={submit} className="flex items-end gap-2">
            <label htmlFor="teach-question" className="sr-only">
              Ask the tutor a question
            </label>
            <Textarea
              id="teach-question"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={4_000}
              rows={1}
              placeholder={
                canAsk
                  ? "Ask about this section"
                  : state.kind === "precheck"
                    ? "You can ask once your lesson is planned"
                    : "You can ask once the tutor finishes"
              }
              disabled={!canAsk}
              className="max-h-40 min-h-11 resize-none rounded-2xl px-4 py-2.5"
            />
            <DictationButton dictation={dictation} disabled={!canAsk} />
            <Button
              type="submit"
              size="icon"
              disabled={!canAsk || !draft.trim()}
              aria-label="Send question"
              className="size-11 shrink-0 rounded-full"
            >
              <SendIcon aria-hidden="true" />
            </Button>
          </form>
        )}
        {state.kind === "no-material" ? null : (
          <DictationStatus dictation={dictation} />
        )}
      </div>
    </div>
  )
}
