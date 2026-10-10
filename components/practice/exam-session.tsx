"use client"

/**
 * The exam screen for one paper. It shows, in order of precedence: the
 * results of the attempt named in `?attempt=`, the attempt in progress (so a
 * reload resumes the timed paper), or a start screen with the paper's size,
 * time allowed, earlier attempts, and a menu to edit its questions or
 * delete it. Papers still being prepared or that failed point back to
 * Practice. The question editor lives in `exam-editor.tsx` at `?edit=1`.
 */

import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { useCallback, useState } from "react"

import { LengthChoice } from "@/components/practice/exam-dialogs"
import { ExamPaperActions } from "@/components/practice/exam-paper-actions"
import { ExamPaper } from "@/components/practice/exam-paper"
import { ExamResults } from "@/components/practice/exam-results"
import { Button } from "@/components/ui/button"
import { ArrowLeftIcon, ArrowRightIcon, LoadingIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { DEFAULT_EXAM_MINUTES } from "@/lib/exam-scoring"

/** Lengths offered when a past paper does not state its time. */
const UNSTATED_LENGTHS = [30, 60, 90, 120] as const

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Formats a submission time in the learner's locale. */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** Renders the exam screen for one paper. */
export function ExamSession({
  projectId,
  paperId,
  attemptId,
}: {
  projectId: string
  paperId: string
  /** Submitted attempt to review, from `?attempt=`. */
  attemptId?: string
}) {
  const router = useRouter()
  const session = useQuery(api.exam.paperSession, {
    paperId: paperId as Id<"examPapers">,
    ...(attemptId ? { attemptId: attemptId as Id<"examAttempts"> } : {}),
  })
  const startAttempt = useMutation(api.exam.startAttempt)
  const [minutes, setMinutes] = useState(String(DEFAULT_EXAM_MINUTES))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState("")
  const practiceHref = `/projects/${encodeURIComponent(projectId)}/practice`
  const paperHref = `${practiceHref}/exam/${encodeURIComponent(paperId)}`

  /** Starts a new attempt (or resumes the open one) and shows the paper. */
  async function start() {
    if (!session || starting) return
    setStarting(true)
    setStartError("")
    try {
      await startAttempt({
        paperId: session.paper.id,
        ...(session.paper.durationMinutes ? {} : { minutes: Number(minutes) }),
      })
      if (attemptId) router.replace(paperHref)
    } catch {
      setStartError("The paper could not be started. Try again.")
    } finally {
      setStarting(false)
    }
  }

  /** Shows the results of an attempt once the server has accepted it. */
  const showResults = useCallback(
    (submittedId: Id<"examAttempts">) =>
      router.replace(`${paperHref}?attempt=${encodeURIComponent(submittedId)}`),
    [paperHref, router]
  )

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-9">
      <Link href={practiceHref}>
        <ArrowLeftIcon aria-hidden="true" /> Practice
      </Link>
    </Button>
  )

  if (session === undefined)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {back}
        <div className="mt-8 space-y-3" aria-label="Loading paper">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </main>
    )

  if (session === null)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {back}
        <h1 className="mt-8 font-heading text-2xl font-semibold">Paper not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been removed. Your other papers are on the Practice screen.
        </p>
      </main>
    )

  const { paper } = session

  if (session.review)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {back}
        <div className="mt-6">
          <ExamResults
            projectId={projectId}
            title={paper.title}
            review={session.review}
            practiceHref={practiceHref}
            onTakeAgain={() => void start()}
            startingAgain={starting}
          />
          {startError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {startError}
            </p>
          ) : null}
        </div>
      </main>
    )

  if (session.active && session.questions.length)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6">
        <h1 className="sr-only">{paper.title}</h1>
        <ExamPaper
          key={session.active.id}
          title={paper.title}
          questions={session.questions}
          attempt={session.active}
          onSubmitted={showResults}
        />
      </main>
    )

  const details = [
    paper.kind === "past" ? "Past paper" : "Mock exam",
    plural(paper.questionCount, "question"),
    paper.totalMarks ? plural(paper.totalMarks, "mark") : "",
    paper.durationMinutes ? `${paper.durationMinutes} minutes` : "",
  ].filter(Boolean)

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      {back}
      <div className="mt-6 flex items-start justify-between gap-3">
        <h1 className="min-w-0 font-heading text-3xl font-semibold tracking-tight break-words sm:text-4xl">
          {paper.title}
        </h1>
        <ExamPaperActions
          paper={{
            id: paper.id,
            title: paper.title,
            status: paper.status,
            changeLock: paper.changeLock,
            hasOpenAttempt: Boolean(session.active),
          }}
          editHref={`${paperHref}?edit=1`}
          onDeleted={() => router.replace(practiceHref)}
        />
      </div>

      {paper.status === "processing" ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          {paper.kind === "past"
            ? "Reading the paper's questions. This page updates when it is ready."
            : "Writing the mock exam. This page updates when it is ready."}
        </p>
      ) : paper.status === "failed" ? (
        <div role="alert" className="mt-4 text-sm">
          <p className="text-destructive">{paper.error ?? "This paper could not be prepared."}</p>
          <p className="mt-1 text-muted-foreground">Retry it from the Practice screen.</p>
        </div>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{details.join(" · ")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              paper.choiceCount ? plural(paper.choiceCount, "choice question") : "",
              paper.writtenCount ? plural(paper.writtenCount, "written question") : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </p>

          <section aria-labelledby="start-heading" className="mt-8 rounded-2xl border border-brand/25 bg-brand/[0.05] p-5 sm:p-6">
            <h2 id="start-heading" className="font-heading text-xl font-semibold">
              Sit the paper
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The timer starts when you start. Answers save as you go, so you can leave and come
              back until time runs out; then the paper is submitted for you. Choice questions are
              marked at once and written answers shortly after.
            </p>
            {paper.inferredAnswerCount ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {paper.inferredAnswerCount === paper.questionCount
                  ? "No solutions came with this paper, so its answers were worked out for you."
                  : `${plural(paper.inferredAnswerCount, "answer")} ${paper.inferredAnswerCount === 1 ? "was" : "were"} worked out without solutions.`}{" "}
                Check any you doubt against your notes.
              </p>
            ) : null}
            {!paper.durationMinutes ? (
              <div className="mt-4">
                <p className="mb-2 text-sm text-muted-foreground">
                  The paper doesn&apos;t state a time. Choose one.
                </p>
                <LengthChoice
                  idPrefix="paper-length"
                  options={UNSTATED_LENGTHS}
                  value={minutes}
                  onChange={setMinutes}
                  disabled={starting}
                />
              </div>
            ) : null}
            <Button
              type="button"
              disabled={starting}
              onClick={() => void start()}
              className="mt-5 min-h-11 w-full rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85 sm:w-auto"
            >
              {starting ? (
                <>
                  <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Starting
                </>
              ) : (
                <>
                  Start exam <ArrowRightIcon aria-hidden="true" />
                </>
              )}
            </Button>
            {startError ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {startError}
              </p>
            ) : null}
          </section>
        </>
      )}

      {session.attempts.length ? (
        <section aria-labelledby="attempts-heading" className="mt-10">
          <h2 id="attempts-heading" className="font-heading text-lg font-semibold">
            Earlier attempts
          </h2>
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
            {session.attempts.map((attempt) => (
              <li
                key={attempt.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium tabular-nums">
                    {attempt.percentage !== null
                      ? `${attempt.percentage}%`
                      : attempt.gradingStatus === "running"
                        ? "Marking written answers"
                        : "Written answers not marked"}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDate(attempt.submittedAt)}</p>
                </div>
                <Button asChild variant="outline" className="min-h-10 shrink-0 rounded-full px-4">
                  <Link href={`${paperHref}?attempt=${encodeURIComponent(attempt.id)}`}>Review</Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}
