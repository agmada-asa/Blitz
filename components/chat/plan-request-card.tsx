"use client"

/**
 * The plan card a project agent shows when Plan first is on: the whole plan
 * to approve or send back, before any file in the project changes. Codex and
 * Claude Code plans arrive as the same `approval/plan` request, so one card
 * serves both. Rendered by `AgentRequestPanel`, above the composer while the
 * plan waits and in the transcript once it is decided.
 */

import { useEffect, useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/ui/markdown"
import { Textarea } from "@/components/ui/textarea"
import { ChevronRightIcon } from "@/components/ai/provider-icons"
import type { AgentRequest, AgentRequestSubmission } from "@/lib/agent-request"
import { cn } from "@/lib/utils"

/** Longest note sent back with a plan. */
const MAX_FEEDBACK_CHARS = 4_000

/** Props for one plan review. */
type PlanRequestCardProps = {
  /** The plan request; its `details` hold the plan as Markdown. */
  request: AgentRequest
  /** Whether the decision is being saved. */
  busy?: boolean
  /** Shows the decided plan as transcript history, without controls. */
  readOnly?: boolean
  /** Optional container class overrides. */
  className?: string
  /** Receives the decision: approved, or denied with an optional note. */
  onSubmit: (submission: AgentRequestSubmission) => void
}

/** Returns the note sent back with a plan, when the stored response has one. */
function sentBackNote(response?: string): string | undefined {
  if (!response) return undefined
  try {
    const value = JSON.parse(response) as { feedback?: unknown }
    return typeof value.feedback === "string" && value.feedback.trim()
      ? value.feedback.trim()
      : undefined
  } catch {
    return undefined
  }
}

/** Returns a compact remaining-time label for the request's lease, such as "4:51". */
function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/**
 * Renders a plan for approval, or the decided plan in the transcript.
 *
 * Approving lets the agent carry the plan out. Sending it back with a note
 * asks for a revised plan; sending it back empty stops the agent without
 * changes. An expired card can no longer be answered.
 */
export function PlanRequestCard({
  request,
  busy = false,
  readOnly = false,
  className,
  onSubmit,
}: PlanRequestCardProps) {
  const [now, setNow] = useState(() => Date.now())
  const [sendingBack, setSendingBack] = useState(false)
  const [note, setNote] = useState("")
  const noteId = useId()
  const expired = request.expiresAt <= now

  // The countdown ticks only while the plan waits for a decision.
  useEffect(() => {
    if (readOnly || expired) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [readOnly, expired])

  if (readOnly) {
    const sentNote = sentBackNote(request.response)
    const state =
      request.status === "approved"
        ? "Approved"
        : request.status === "denied"
          ? sentNote
            ? "Sent back"
            : "Not approved"
          : request.status === "expired"
            ? "Expired"
            : request.status === "cancelled"
              ? "Cancelled"
              : "Waiting"
    return (
      <section
        aria-label={`Plan: ${state}`}
        className={cn(
          "rounded-xl border border-border/70 bg-muted/20 p-3 text-sm",
          className
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-foreground">{request.title}</h3>
          <span className="text-xs text-muted-foreground">{state}</span>
        </div>
        <details className="group mt-2">
          <summary className="flex cursor-pointer items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground select-none hover:text-foreground">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            <span>View plan</span>
          </summary>
          <div className="mt-2 text-sm">
            <Markdown text={request.details} />
          </div>
        </details>
        {sentNote ? (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Your note: {sentNote}
          </p>
        ) : null}
      </section>
    )
  }

  return (
    <section
      aria-label={request.title}
      className="mb-2 rounded-2xl border border-brand/30 bg-brand/5 p-3 shadow-sm sm:p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {request.title}
          </h2>
          {request.prompt ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {request.prompt}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 text-xs text-muted-foreground tabular-nums",
            expired && "text-destructive"
          )}
        >
          {expired ? "Expired" : remaining(request.expiresAt, now)}
        </span>
      </div>

      <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-sm">
        <Markdown text={request.details} />
      </div>

      {sendingBack ? (
        <div className="mt-3 space-y-2">
          <label
            htmlFor={noteId}
            className="block text-xs font-medium text-foreground"
          >
            What should change?
          </label>
          <Textarea
            id={noteId}
            autoFocus
            value={note}
            maxLength={MAX_FEEDBACK_CHARS}
            disabled={busy || expired}
            placeholder="Leave empty to stop without changes"
            className="min-h-20 text-sm"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || expired}
              onClick={() =>
                onSubmit({
                  decision: "denied",
                  ...(note.trim()
                    ? { response: JSON.stringify({ feedback: note.trim() }) }
                    : {}),
                })
              }
            >
              {busy ? "Saving…" : note.trim() ? "Send back" : "Stop here"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSendingBack(false)}
            >
              Keep reviewing
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || expired}
            onClick={() => onSubmit({ decision: "approved" })}
          >
            {busy ? "Saving…" : "Approve and start"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || expired}
            onClick={() => setSendingBack(true)}
          >
            Send back
          </Button>
        </div>
      )}
    </section>
  )
}
