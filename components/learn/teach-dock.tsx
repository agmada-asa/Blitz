"use client"

/**
 * The bottom of the Teach screen: one-tap replies that move the lesson along,
 * a box for the learner's own questions, and pause or resume controls while
 * the tutor is writing. After the recap it offers practice and the next unit.
 */

import Link from "next/link"
import { useState, type FormEvent, type KeyboardEvent } from "react"

import { Button } from "@/components/ui/button"
import { ArrowRightIcon, SendIcon } from "@/components/ui/icon"
import { Textarea } from "@/components/ui/textarea"
import { TEACH_QUICK_REPLIES } from "@/lib/teach"

/** What the dock should offer for the session's current state. */
export type TeachDockState =
  | { kind: "no-material" }
  | { kind: "starting" }
  | { kind: "writing" }
  | { kind: "paused"; hasText: boolean }
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
        ) : state.kind === "ready" ? (
          <div className="-mx-1 flex [scrollbar-width:none] gap-2 overflow-x-auto px-1 pb-0.5">
            <Button
              type="button"
              onClick={() => onSend(TEACH_QUICK_REPLIES.next)}
              className="min-h-11 shrink-0 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              {state.isLastSection ? "Finish unit" : "Next section"}
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
                  : "You can ask once the tutor finishes"
              }
              disabled={!canAsk}
              className="max-h-40 min-h-11 resize-none rounded-2xl px-4 py-2.5"
            />
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
      </div>
    </div>
  )
}
