"use client"

/**
 * Results of a submitted exam attempt: the score, the state of written
 * answer marking (with a retry when it failed), a per-concept breakdown with
 * the weakest concept first and a way to relearn each one, and every
 * question with the learner's answer, the correct or model answer, and
 * feedback.
 */

import Link from "next/link"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { relearnLink } from "@/components/practice/practice-hub"
import { Button } from "@/components/ui/button"
import { CancelIcon, CheckCircleIcon, LoadingIcon } from "@/components/ui/icon"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
import { Progress } from "@/components/ui/progress"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"

/** The full review of a submitted attempt. */
type Review = NonNullable<NonNullable<FunctionReturnType<typeof api.exam.paperSession>>["review"]>

/** One reviewed question. */
type ReviewItem = Review["items"][number]

/** Formats marks, showing a half mark as .5. */
function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1)
}

/** Formats "n of m marks". */
function marksOf(awarded: number, available: number): string {
  return `${formatMarks(awarded)} of ${formatMarks(available)} mark${available === 1 ? "" : "s"}`
}

/** Text and colour for a question's outcome, never relying on colour alone. */
function outcomeLabel(item: ReviewItem): { text: string; tone: "good" | "bad" | "neutral" } {
  if (item.outcome === "correct") return { text: "Correct", tone: "good" }
  if (item.outcome === "incorrect") return { text: "Incorrect", tone: "bad" }
  if (item.outcome === "unanswered") return { text: "Not answered", tone: "neutral" }
  if (item.outcome === "pending") return { text: "Waiting for marking", tone: "neutral" }
  const awarded = item.awardedMarks ?? 0
  return {
    text: marksOf(awarded, item.marks),
    tone: awarded >= item.marks ? "good" : awarded === 0 ? "bad" : "neutral",
  }
}

/** Tailwind classes for each outcome tone. */
const toneClass = {
  good: "text-emerald-700 dark:text-emerald-300",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
} as const

/**
 * Renders the results of one submitted attempt.
 * @param onTakeAgain Starts a new attempt at the same paper.
 */
export function ExamResults({
  projectId,
  title,
  review,
  practiceHref,
  onTakeAgain,
  startingAgain,
}: {
  projectId: string
  title: string
  review: Review
  practiceHref: string
  onTakeAgain: () => void
  startingAgain: boolean
}) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState("")
  const { totals } = review
  const marking = review.gradingStatus === "running"
  const markingFailed = review.gradingStatus === "failed"

  /** Asks the server to mark the written answers again. */
  async function retryMarking() {
    setRetrying(true)
    setRetryError("")
    const response = await fetch("/api/practice/exam/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: review.id }),
    }).catch(() => null)
    setRetrying(false)
    if (!response?.ok) setRetryError("Marking could not be restarted. Try again.")
  }

  return (
    <>
      <section aria-labelledby="results-heading">
        <p className="text-sm text-muted-foreground">{title}</p>
        <h1 id="results-heading" className="mt-1 font-heading text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
          {formatMarks(totals.awarded)} of {formatMarks(totals.available)} marks
          {totals.percentage !== null ? (
            <span className="ml-3 text-xl font-medium text-muted-foreground sm:text-2xl">
              {totals.percentage}%
            </span>
          ) : null}
        </h1>
        {totals.pending > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            So far. {formatMarks(totals.pending)} mark{totals.pending === 1 ? "" : "s"} for written
            answers still to come.
          </p>
        ) : null}

        {review.autoSubmitted ? (
          <p className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-sm">
            Time ran out, so your paper was submitted automatically with the answers you had
            saved.
          </p>
        ) : null}
        {marking ? (
          <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            Marking written answers…
          </p>
        ) : null}
        {markingFailed ? (
          <div role="alert" className="mt-4 rounded-xl border border-destructive/40 p-4 text-sm">
            <p className="text-destructive">
              {review.gradingError ?? "Written answers could not be marked. Try again."}
            </p>
            <p className="mt-1 text-muted-foreground">
              Your choice-question results are below.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={retrying}
              onClick={() => void retryMarking()}
              className="mt-3 min-h-10 rounded-full px-4"
            >
              {retrying ? (
                <>
                  <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Restarting
                </>
              ) : (
                "Try marking again"
              )}
            </Button>
            {retryError ? <p className="mt-2 text-destructive">{retryError}</p> : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={startingAgain}
            onClick={onTakeAgain}
            className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
          >
            {startingAgain ? (
              <>
                <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Starting
              </>
            ) : (
              "Take again"
            )}
          </Button>
          <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
            <Link href={practiceHref}>Back to Practice</Link>
          </Button>
        </div>
      </section>

      {review.breakdown.length ? (
        <section aria-labelledby="concepts-heading" className="mt-10">
          <h2 id="concepts-heading" className="font-heading text-lg font-semibold">
            By concept
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Weakest first.
            {totals.pending > 0 ? " Written answers join in once they are marked." : ""}
          </p>
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {review.breakdown.map((row) => (
              <li
                key={row.concept}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{row.concept}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {marksOf(row.awarded, row.available)} · {row.percentage}%
                    {row.unanswered ? ` · ${row.unanswered} not answered` : ""}
                  </p>
                  <Progress
                    value={row.percentage}
                    aria-label={`${row.concept}: ${row.percentage}%`}
                    className="mt-2 h-1 max-w-xs [&_[data-slot=progress-indicator]]:bg-brand"
                  />
                </div>
                {row.unitId && row.percentage < 100 ? (
                  <Button asChild variant="outline" className="min-h-10 shrink-0 rounded-full px-4">
                    <Link {...relearnLink(projectId, row.unitId, row.concept)}>Relearn</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="answers-heading" className="mt-10">
        <h2 id="answers-heading" className="font-heading text-lg font-semibold">
          Questions
        </h2>
        <ol className="mt-3 space-y-4">
          {review.items.map((item) => (
            <li key={item.id}>
              <ReviewedQuestion projectId={projectId} item={item} />
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}

/** One question with the learner's answer, the correct or model answer, and feedback. */
function ReviewedQuestion({ projectId, item }: { projectId: string; item: ReviewItem }) {
  const label = outcomeLabel(item)
  const lostMarks =
    item.outcome === "incorrect" ||
    item.outcome === "unanswered" ||
    (item.outcome === "marked" && (item.awardedMarks ?? 0) < item.marks)

  return (
    <article
      aria-labelledby={`review-${item.id}`}
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={`review-${item.id}`} className="text-sm font-semibold">
          Question {item.number}
          <span className="ml-2 font-normal text-muted-foreground">{item.concept}</span>
        </h3>
        <p className={cn("flex items-center gap-1 text-xs font-medium", toneClass[label.tone])}>
          {label.tone === "good" ? (
            <CheckCircleIcon size={14} aria-hidden="true" />
          ) : label.tone === "bad" ? (
            <CancelIcon size={14} aria-hidden="true" />
          ) : null}
          {item.outcome === "marked" || item.outcome === "pending"
            ? label.text
            : `${label.text} · ${marksOf(item.awardedMarks ?? 0, item.marks)}`}
        </p>
      </div>
      <div className="mt-2 min-w-0 text-sm">{plainMarkdownRenderer(item.prompt)}</div>

      {item.type === "written" ? (
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">Your answer</h4>
            {item.text.trim() ? (
              <p className="mt-1 break-words whitespace-pre-wrap">{item.text}</p>
            ) : (
              <p className="mt-1 text-muted-foreground">Not answered.</p>
            )}
          </div>
          {item.feedback ? (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">Feedback</h4>
              <p className="mt-1">{item.feedback}</p>
            </div>
          ) : null}
          {item.modelAnswer ? (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">Model answer</h4>
              <div className="mt-1">{plainMarkdownRenderer(item.modelAnswer)}</div>
            </div>
          ) : null}
          {item.markScheme.length ? (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground">Mark scheme</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {item.markScheme.map((point, index) => (
                  <li key={index}>
                    {point.point}{" "}
                    <span className="text-muted-foreground">
                      ({formatMarks(point.marks)} mark{point.marks === 1 ? "" : "s"})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="mt-3 grid gap-2">
            {item.options.map((option, index) => {
              const chosen = item.selectedOptionIds.includes(option.id)
              const correct = item.correctOptionIds.includes(option.id)
              const mark = chosen
                ? correct
                  ? "Your answer, correct"
                  : "Your answer, incorrect"
                : correct
                  ? "Correct answer"
                  : ""
              return (
                <li
                  key={option.id}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-sm",
                    correct && "border-emerald-500/45 bg-emerald-500/[0.06]",
                    chosen && !correct && "border-destructive/45 bg-destructive/[0.06]"
                  )}
                >
                  {item.type !== "true-false" ? (
                    <span aria-hidden="true" className="text-xs text-muted-foreground">
                      {String.fromCharCode(65 + index)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    {plainMarkdownRenderer(option.text, { inline: true })}
                  </span>
                  {mark ? (
                    <span
                      className={cn(
                        "ml-auto flex shrink-0 items-center gap-1 text-xs font-medium",
                        correct ? toneClass.good : toneClass.bad
                      )}
                    >
                      {correct ? (
                        <CheckCircleIcon size={14} aria-hidden="true" />
                      ) : (
                        <CancelIcon size={14} aria-hidden="true" />
                      )}
                      {mark}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {item.explanation ? (
            <div className="mt-3 text-sm">{plainMarkdownRenderer(item.explanation)}</div>
          ) : null}
        </>
      )}

      {item.answerSource === "inferred" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No solutions covered this question, so its answer was worked out for you. Check it
          against your notes.
        </p>
      ) : null}
      {lostMarks && item.unitId ? (
        <Button asChild variant="outline" className="mt-3 min-h-10 rounded-full px-4">
          <Link {...relearnLink(projectId, item.unitId, item.concept, item.prompt)}>Relearn this</Link>
        </Button>
      ) : null}
    </article>
  )
}
