"use client"

/**
 * Results of a submitted exam attempt: the score beside Take again, the state
 * of written answer marking (with a retry when it failed), a per-concept
 * breakdown with the weakest concept first and a way to relearn each one
 * (full-mark concepts fold into one row), and every question as a row that
 * opens to the learner's answer, the correct or model answer, and feedback
 * (full-mark questions fold into one row).
 */

import Link from "next/link"
import type { FunctionReturnType } from "convex/server"
import { useId, useState, type ReactNode } from "react"

import { relearnLink } from "@/components/practice/practice-hub"
import { Button } from "@/components/ui/button"
import {
  ArrowRightIcon,
  CancelIcon,
  CheckCircleIcon,
  CheckIcon,
  LoadingIcon,
} from "@/components/ui/icon"
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

  const weak = review.breakdown.filter((row) => row.percentage < 100)
  const fullMarks = review.breakdown.filter((row) => row.percentage >= 100)
  const lost = review.items.filter((item) => !hasFullMarks(item))
  const full = review.items.filter(hasFullMarks)

  return (
    <>
      <section aria-labelledby="results-heading">
        {/* The score and the next actions share one row; they wrap under it on a phone. */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{title}</p>
            <h1 id="results-heading" className="mt-1 flex flex-wrap items-baseline gap-x-3 font-heading tabular-nums">
              <span className="text-4xl font-semibold tracking-tight sm:text-5xl">
                {formatMarks(totals.awarded)}
              </span>
              <span className="text-xl font-medium text-muted-foreground sm:text-2xl">
                of {formatMarks(totals.available)} marks
              </span>
              {totals.percentage !== null ? (
                <span className="self-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {totals.percentage}%
                </span>
              ) : null}
            </h1>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button asChild variant="ghost" className="min-h-11 rounded-full px-4 text-muted-foreground">
              <Link href={practiceHref}>Back to Practice</Link>
            </Button>
            <Button
              type="button"
              disabled={startingAgain}
              onClick={onTakeAgain}
              className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              {startingAgain ? (
                <>
                  <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Starting
                </>
              ) : (
                "Take again"
              )}
            </Button>
          </div>
        </div>
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
      </section>

      {review.breakdown.length ? (
        <section aria-labelledby="concepts-heading" className="mt-10">
          <h2 id="concepts-heading" className="flex flex-wrap items-baseline gap-x-2 font-heading text-lg font-semibold">
            By concept
            <span className="text-sm font-normal text-muted-foreground">
              weakest first
              {totals.pending > 0 ? ". Written answers join in once they are marked." : ""}
            </span>
          </h2>
          <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
            <ul className="divide-y divide-border">
              {weak.map((row) => (
                <ConceptRow key={row.concept} row={row} projectId={projectId} />
              ))}
            </ul>
            {fullMarks.length ? (
              <Disclosure
                className={cn(weak.length > 0 && "border-t border-border")}
                summary={
                  <>
                    <OutcomeMark tone="good" />
                    <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                      {fullMarks.length} concept{fullMarks.length === 1 ? "" : "s"} with full marks
                    </span>
                  </>
                }
              >
                <ul className="divide-y divide-border border-t border-border">
                  {fullMarks.map((row) => (
                    <ConceptRow key={row.concept} row={row} projectId={projectId} />
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="answers-heading" className="mt-10">
        <h2 id="answers-heading" className="font-heading text-lg font-semibold">
          Questions
        </h2>
        {/* Each question is one row that opens to its answers; full marks fold into one row. */}
        <div className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {lost.length ? (
            <ol className="divide-y divide-border">
              {lost.map((item) => (
                <li key={item.id}>
                  <QuestionRow projectId={projectId} item={item} />
                </li>
              ))}
            </ol>
          ) : null}
          {full.length ? (
            <Disclosure
              summary={
                <>
                  <OutcomeMark tone="good" />
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {full.map((item) => `Q${item.number}`).join(", ")} full marks
                  </span>
                </>
              }
            >
              <ol className="divide-y divide-border border-t border-border">
                {full.map((item) => (
                  <li key={item.id}>
                    <QuestionRow projectId={projectId} item={item} />
                  </li>
                ))}
              </ol>
            </Disclosure>
          ) : null}
        </div>
      </section>
    </>
  )
}

/** Whether a question earned every mark it was worth. Unmarked written answers do not count yet. */
function hasFullMarks(item: ReviewItem): boolean {
  if (item.outcome === "correct") return true
  return item.outcome === "marked" && (item.awardedMarks ?? 0) >= item.marks
}

/**
 * A row that opens to show more under it, used for folded groups and questions.
 * @param summary The row's visible content after the chevron.
 * @param children What opens under the row.
 * @param className Extra classes for the wrapper, such as a top border.
 */
function Disclosure({
  summary,
  children,
  className,
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:px-5"
      >
        {summary}
        <ArrowRightIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  )
}

/** A small round mark for an outcome: a tick, a cross, or a half for part marks. */
function OutcomeMark({ tone }: { tone: "good" | "bad" | "neutral" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "neutral" && "bg-muted text-muted-foreground"
      )}
    >
      {tone === "good" ? (
        <CheckIcon className="size-3.5" />
      ) : tone === "bad" ? (
        <CancelIcon className="size-3.5" />
      ) : (
        "½"
      )}
    </span>
  )
}

/** One concept's marks with a bar, and Relearn when marks were lost. */
function ConceptRow({ row, projectId }: { row: Review["breakdown"][number]; projectId: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{row.concept}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {marksOf(row.awarded, row.available)}
          {row.unanswered ? ` · ${row.unanswered} not answered` : ""}
        </p>
        <Progress
          value={row.percentage}
          aria-label={`${row.concept}: ${row.percentage}%`}
          className="mt-2 h-1 max-w-44 [&_[data-slot=progress-indicator]]:bg-brand"
        />
      </div>
      {row.unitId && row.percentage < 100 ? (
        <Button asChild variant="outline" className="min-h-10 shrink-0 rounded-full px-4">
          <Link {...relearnLink(projectId, row.unitId, row.concept)}>Relearn</Link>
        </Button>
      ) : null}
    </li>
  )
}

/** A question's prompt as one plain line for its folded row: Markdown marks and line breaks removed. */
function promptLine(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]|\$+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * One question as a folded row: its outcome mark, number, prompt and marks.
 * Opening it shows the full question, the answers and any feedback.
 */
function QuestionRow({ projectId, item }: { projectId: string; item: ReviewItem }) {
  const label = outcomeLabel(item)
  const partial = item.outcome === "marked" && (item.awardedMarks ?? 0) > 0 && !hasFullMarks(item)
  const tone = hasFullMarks(item) ? "good" : partial || item.outcome === "pending" ? "neutral" : "bad"
  const marks =
    item.outcome === "pending" ? label.text : marksOf(item.awardedMarks ?? 0, item.marks)
  return (
    <Disclosure
      summary={
        <>
          <OutcomeMark tone={tone} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              Q{item.number} · {promptLine(item.prompt)}
            </span>
            <span className="block text-xs text-muted-foreground">
              {marks}
              {item.type === "written" ? " · written" : ""}
              <span className="sr-only">. {label.text}</span>
            </span>
          </span>
        </>
      }
    >
      <div className="px-4 pb-5 sm:px-5 sm:pl-14">
        <ReviewedQuestion projectId={projectId} item={item} />
      </div>
    </Disclosure>
  )
}

/**
 * Panel style for each part of a reviewed written answer. Each part gets its
 * own treatment so the learner can tell at a glance where their answer ends
 * and the feedback, model answer and mark scheme begin: their own words sit
 * in a plain fill, feedback has a brand tint, the model answer has a tint of
 * the same green used for correct options, and the mark scheme is a quiet
 * outline because it is reference material.
 */
const sectionTone = {
  answer: "bg-muted/60",
  feedback: "bg-brand/[0.07]",
  model: "bg-emerald-500/[0.06]",
  scheme: "border border-border",
} as const

/** Heading colour for each section, matched to its panel. */
const sectionTitleTone = {
  answer: "text-muted-foreground",
  feedback: "text-brand",
  model: toneClass.good,
  scheme: "text-muted-foreground",
} as const

/**
 * One labelled part of a reviewed written answer, drawn as its own panel.
 * @param title Visible section heading, such as "Feedback".
 * @param tone Which part this is; sets the panel and heading styles.
 * @param children The section's content.
 */
function ReviewSection({
  title,
  tone,
  children,
}: {
  title: string
  tone: keyof typeof sectionTone
  children: ReactNode
}) {
  return (
    <div className={cn("rounded-lg px-4 py-3", sectionTone[tone])}>
      <h4 className={cn("mb-1.5 text-xs font-semibold", sectionTitleTone[tone])}>{title}</h4>
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
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
    <article aria-labelledby={`review-${item.id}`}>
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
        <div className="mt-5 space-y-3 border-t border-border pt-5 text-sm">
          <ReviewSection title="Your answer" tone="answer">
            {item.text.trim() ? (
              <p className="break-words whitespace-pre-wrap">{item.text}</p>
            ) : (
              <p className="text-muted-foreground">Not answered.</p>
            )}
          </ReviewSection>
          {item.feedback ? (
            <ReviewSection title="Feedback" tone="feedback">
              <p>{item.feedback}</p>
            </ReviewSection>
          ) : null}
          {item.modelAnswer ? (
            <ReviewSection title="Model answer" tone="model">
              {plainMarkdownRenderer(item.modelAnswer)}
            </ReviewSection>
          ) : null}
          {item.markScheme.length ? (
            <ReviewSection title="Mark scheme" tone="scheme">
              <ul className="divide-y divide-border">
                {item.markScheme.map((point, index) => (
                  <li key={index} className="flex items-baseline gap-4 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1">{point.point}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatMarks(point.marks)} mark{point.marks === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </ReviewSection>
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
            <div className="mt-3 text-sm">
              <ReviewSection title="Explanation" tone="feedback">
                {plainMarkdownRenderer(item.explanation)}
              </ReviewSection>
            </div>
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
