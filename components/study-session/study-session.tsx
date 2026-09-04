"use client"

/**
 * Renders one-question-at-a-time deliberate study and test sessions.
 *
 * The component loads question-only data through the shared HTTP contract.
 * Practice sends each answer immediately. Test keeps selections local until
 * Finish, then submits each answer with a stable idempotency key so a failed
 * request can be retried without changing the recorded attempt.
 */

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  getSessionProgress,
  makeAnswerSubmission,
  summarizeSessionResults,
  type SessionAnswer,
  type SessionAnswerResult,
  type SessionQuestion,
  type SessionQuestionPage,
  type SessionResultSummary,
} from "@/lib/learning/session-contracts"

/** The two deliberate session modes supported by the routes. */
export type StudySessionMode = "practice" | "test"

/** Props shared by the project practice and test routes. */
export interface StudySessionProps {
  /** Project whose prepared questions should be shown. */
  readonly projectId: string
  /** Whether to score each answer immediately or at Finish. */
  readonly mode: StudySessionMode
  /** Optional project-owned topic filter. */
  readonly topicId?: string
}

/** Renders the deliberate session shell and its current question. */
export function StudySession({ projectId, mode, topicId }: StudySessionProps) {
  const [sessionId] = useState(createLocalSessionId)
  const [startedAt] = useState(() => Date.now())
  const [deck, setDeck] = useState<SessionQuestionPage>()
  const [loadedKey, setLoadedKey] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [draftAnswer, setDraftAnswer] = useState<SessionAnswer>()
  const [testAnswers, setTestAnswers] = useState<
    Record<string, SessionAnswer | undefined>
  >({})
  const [practiceResults, setPracticeResults] = useState<
    Record<string, SessionAnswerResult | undefined>
  >({})
  const [testResults, setTestResults] = useState<
    Record<string, SessionAnswerResult | undefined>
  >({})
  const [submitting, setSubmitting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finished, setFinished] = useState(false)
  const [testLocked, setTestLocked] = useState(false)
  const [complete, setComplete] = useState(false)
  const [requestError, setRequestError] = useState<string>()
  const requestKey = `${projectId}:${topicId ?? ""}`
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ projectId, limit: "20" })
    if (topicId) params.set("topicId", topicId)
    void fetch(`/api/learning/session?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as unknown
        if (!response.ok) throw new Error(readError(body))
        return body as SessionQuestionPage
      })
      .then((page) => {
        setDeck(page)
        setLoadError(undefined)
        setLoadedKey(requestKey)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        setLoadError(
          error instanceof Error
            ? error.message
            : "Questions could not be loaded"
        )
        setLoadedKey(requestKey)
      })
    return () => controller.abort()
  }, [loadAttempt, projectId, requestKey, topicId])

  const questions = useMemo(() => deck?.items ?? [], [deck])
  const question = questions[currentIndex]
  const selectedAnswer =
    mode === "test"
      ? question
        ? testAnswers[question.itemId]
        : undefined
      : draftAnswer
  const practiceResult = question ? practiceResults[question.itemId] : undefined
  const progress = useMemo(
    () => getSessionProgress(questions, testAnswers),
    [questions, testAnswers]
  )

  /** Changes the current question while clearing practice-only draft state. */
  function moveTo(index: number): void {
    setCurrentIndex(index)
    setDraftAnswer(undefined)
    setRequestError(undefined)
  }

  /** Advances after an answered practice question or an intentional skip. */
  function advance(): void {
    if (currentIndex >= questions.length - 1) {
      setComplete(true)
      return
    }
    moveTo(currentIndex + 1)
  }

  /** Stores a test answer or submits a practice answer to the server. */
  function chooseAnswer(answer: SessionAnswer): void {
    if (
      !question ||
      submitting ||
      practiceResult ||
      (mode === "test" && testLocked)
    )
      return
    if (mode === "test") {
      setTestAnswers((previous) => ({
        ...previous,
        [question.itemId]: answer,
      }))
      return
    }
    setDraftAnswer(answer)
    if (question.type !== "multiple-answer") void submitPractice(answer)
  }

  /** Toggles one option in a multiple-answer selection. */
  function toggleMultipleOption(optionId: string): void {
    const current = Array.isArray(selectedAnswer) ? selectedAnswer : []
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId]
    chooseAnswer(next)
  }

  /** Posts one practice answer and stores the server's feedback. */
  async function submitPractice(answer: SessionAnswer): Promise<void> {
    if (!question || submitting) return
    setSubmitting(true)
    setRequestError(undefined)
    try {
      const result = await postAnswer(
        makeAnswerSubmission(sessionId, question, answer, startedAt),
        projectId
      )
      if (result.status === "invalid") {
        setRequestError("That answer could not be checked. Try again.")
      } else {
        setPracticeResults((previous) => ({
          ...previous,
          [question.itemId]: result,
        }))
      }
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Answer could not be saved"
      )
    } finally {
      setSubmitting(false)
    }
  }

  /** Submits answered test questions once, retaining partial results on failure. */
  async function finishTest(): Promise<void> {
    if (finishing) return
    setTestLocked(true)
    setFinishing(true)
    setRequestError(undefined)
    const nextResults = { ...testResults }
    try {
      for (const candidate of questions) {
        const answer = testAnswers[candidate.itemId]
        if (answer === undefined || nextResults[candidate.itemId]) continue
        const result = await postAnswer(
          makeAnswerSubmission(sessionId, candidate, answer, startedAt),
          projectId
        )
        if (result.status === "invalid")
          throw new Error("One answer could not be checked")
        nextResults[candidate.itemId] = result
        setTestResults({ ...nextResults })
      }
      setFinished(true)
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? `${error.message}. Finish again to retry the remaining answers.`
          : "Some answers could not be saved. Finish again to retry."
      )
    } finally {
      setFinishing(false)
    }
  }

  if (loadedKey !== requestKey)
    return <SessionStatus message="Loading questions…" />
  if (deck === undefined)
    return (
      <SessionStatus
        message={loadError ?? "Questions could not be loaded"}
        projectId={projectId}
        onRetry={() => {
          setLoadError(undefined)
          setLoadedKey(undefined)
          setLoadAttempt((attempt) => attempt + 1)
        }}
      />
    )
  if (loadError)
    return (
      <SessionStatus
        message={loadError}
        projectId={projectId}
        onRetry={() => {
          setLoadError(undefined)
          setLoadedKey(undefined)
          setLoadAttempt((attempt) => attempt + 1)
        }}
      />
    )
  if (!questions.length)
    return (
      <SessionStatus
        message={
          deck.isDone
            ? "There are no questions in this selection yet."
            : "The initial question deck is limited. Try again to load more prepared material."
        }
        projectId={projectId}
      />
    )
  if (mode === "test" && finished)
    return (
      <TestResults
        questions={questions}
        results={testResults}
        progress={progress}
        projectId={projectId}
      />
    )
  if (mode === "practice" && complete)
    return (
      <SessionStatus
        message="Practice session complete."
        projectId={projectId}
      />
    )
  if (!question)
    return (
      <SessionStatus message="This session has ended." projectId={projectId} />
    )

  const answeredTest = mode === "test" && selectedAnswer !== undefined
  const canCheckMultiple =
    question.type === "multiple-answer" &&
    Array.isArray(selectedAnswer) &&
    selectedAnswer.length > 0
  const isLast = currentIndex === questions.length - 1

  return (
    <main className="flex min-h-svh flex-col bg-[#080808] font-sans text-white selection:bg-[#ff8065] selection:text-[#1b0d0a]">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5 sm:px-8">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-10 rounded-[20px] bg-white/[0.045] px-3.5 text-sm text-white/65 ring-1 ring-white/10 hover:bg-white/[0.09] hover:text-white"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>Exit</Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          {mode === "practice" ? "Study" : "Test"} · {currentIndex + 1} of{" "}
          {questions.length}
        </p>
        <span className="w-12" aria-hidden="true" />
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 pb-12 sm:px-8">
        <h1 className="max-w-[620px] text-[clamp(2rem,7vw,3.75rem)] leading-[0.99] font-medium tracking-[-0.045em] text-white sm:text-[clamp(2rem,5vw,2.5rem)]">
          {question.prompt}
        </h1>

        {question.type === "multiple-answer" ? (
          <p className="mt-5 text-sm text-white/60">Select all that apply</p>
        ) : null}
        <div
          className="mt-6 space-y-2.5"
          role={question.type === "multiple-answer" ? "group" : "radiogroup"}
          aria-label={
            question.type === "multiple-answer"
              ? "Select all that apply"
              : "Answer options"
          }
          aria-busy={submitting || finishing}
        >
          {sessionOptions(question).map((option) => {
            const selected = isOptionSelected(
              question,
              selectedAnswer,
              option.id
            )
            const correct = optionIsCorrect(question, practiceResult, option.id)
            return (
              <Button
                key={option.id}
                type="button"
                role={
                  question.type === "multiple-answer" ? "checkbox" : "radio"
                }
                disabled={
                  submitting ||
                  Boolean(practiceResult) ||
                  (mode === "test" && testLocked)
                }
                aria-pressed={selected}
                aria-checked={selected}
                onClick={() =>
                  question.type === "multiple-answer"
                    ? toggleMultipleOption(option.id)
                    : chooseAnswer(
                        question.type === "true-false"
                          ? option.id === "true"
                          : option.id
                      )
                }
                variant="ghost"
                className={`flex h-auto min-h-14 w-full items-center justify-start gap-4 whitespace-normal rounded-2xl border border-white/10 bg-white/[0.045] px-4 text-left text-sm text-white/80 transition-[background-color,border-color,transform] duration-200 hover:border-white/22 hover:bg-white/[0.075] focus-visible:ring-2 focus-visible:ring-[#ff8065] focus-visible:outline-none active:scale-[0.99] disabled:cursor-default disabled:opacity-100 sm:px-5 sm:text-base ${
                  practiceResult && correct
                    ? "border-emerald-400/65 bg-emerald-400/10 text-emerald-100"
                    : practiceResult && selected
                      ? "border-red-300/60 bg-red-300/10 text-red-100"
                      : selected
                        ? "border-[#ff8065]/65 bg-[#ff8065]/10 text-white"
                        : ""
                }`}
              >
                {option.text}
              </Button>
            )
          })}
        </div>

        {requestError ? (
          <p className="mt-5 text-sm text-destructive" role="alert">
            {requestError}
          </p>
        ) : null}
        {practiceResult ? <AnswerFeedback result={practiceResult} /> : null}

        <div className="mt-9 flex flex-wrap items-center justify-between gap-3">
          {mode === "test" && currentIndex > 0 ? (
            <Button
              variant="ghost"
              onClick={() => moveTo(currentIndex - 1)}
              disabled={testLocked}
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex gap-2">
            {mode === "test" && !isLast ? (
              <Button
                onClick={() => moveTo(currentIndex + 1)}
                disabled={testLocked}
              >
                {answeredTest ? "Next" : "Skip"}
              </Button>
            ) : mode === "test" ? (
              <Button onClick={() => void finishTest()} disabled={finishing}>
                {finishing
                  ? "Saving…"
                  : testLocked
                    ? "Retry remaining"
                    : "Finish test"}
              </Button>
            ) : question.type === "multiple-answer" && !practiceResult ? (
              <Button
                onClick={() => void submitPractice(selectedAnswer ?? [])}
                disabled={!canCheckMultiple}
              >
                Check answer
              </Button>
            ) : practiceResult ? (
              <Button
                onClick={advance}
                disabled={submitting}
              >
                {isLast ? "Finish" : "Next"}
              </Button>
            ) : null}
            {mode === "practice" && !practiceResult ? (
              <Button variant="ghost" onClick={advance} disabled={submitting}>
                Skip
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  )
}

/** Renders a status or empty state without inventing progress data. */
function SessionStatus({
  message,
  projectId,
  onRetry,
}: {
  message: string
  projectId?: string
  onRetry?: () => void
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[#080808] px-5 text-center font-sans text-white">
      <div className="max-w-md space-y-5">
        <p className="text-sm text-white/62">{message}</p>
        <div className="flex justify-center gap-2">
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {projectId ? (
            <Button asChild variant="ghost">
              <Link href={`/projects/${encodeURIComponent(projectId)}`}>
                Back to project
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </main>
  )
}

/** Renders server feedback after a practice answer. */
function AnswerFeedback({ result }: { result: SessionAnswerResult }) {
  return (
    <div className="mt-6 space-y-1.5" role="status">
      <p
        className={
          result.status === "correct"
            ? "text-sm font-medium text-emerald-300"
            : "text-sm font-medium text-red-300"
        }
      >
        {result.status === "correct"
          ? "Correct"
          : result.status === "incorrect"
            ? "Incorrect"
            : "Answer could not be scored"}
      </p>
      {result.feedback?.body ? (
        <p className="text-sm leading-relaxed text-white/52">
          {result.feedback.body}
        </p>
      ) : null}
    </div>
  )
}

/** Renders real test results and the explanations returned by the server. */
function TestResults({
  questions,
  results,
  progress,
  projectId,
}: {
  questions: readonly SessionQuestion[]
  results: Readonly<Record<string, SessionAnswerResult | undefined>>
  progress: { total: number; answered: number; unanswered: number }
  projectId: string
}) {
  const summary: SessionResultSummary = summarizeSessionResults(
    progress.total,
    Object.values(results).filter(
      (result): result is SessionAnswerResult => result !== undefined
    ),
    progress.unanswered
  )
  return (
    <main className="min-h-svh bg-[#080808] px-5 py-8 font-sans text-white sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-10 rounded-[20px] bg-white/[0.045] px-3.5 text-sm text-white/65 ring-1 ring-white/10 hover:bg-white/[0.09] hover:text-white"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>Exit</Link>
        </Button>
        <h1 className="mt-12 text-3xl font-medium tracking-tight">
          Test results
        </h1>
        <p className="mt-3 text-sm text-white/62">
          {summary.correct} correct · {summary.incorrect} incorrect ·{" "}
          {summary.unanswered} unanswered
        </p>
        <div className="mt-10 space-y-7">
          {questions.map((question, index) => {
            const result = results[question.itemId]
            return (
              <article
                key={question.itemId}
                className="border-t border-white/10 pt-5"
              >
                <p className="text-xs text-white/45">Question {index + 1}</p>
                <h2 className="mt-2 font-medium">{question.prompt}</h2>
                <p className="mt-2 text-sm text-white/62">
                  {result
                    ? result.status === "correct"
                      ? "Correct"
                      : result.status === "incorrect"
                        ? "Incorrect"
                        : "Could not score this answer"
                    : "Unanswered"}
                </p>
                {result?.feedback?.body ? (
                  <p className="mt-2 text-sm leading-relaxed text-white/52">
                    {result.feedback.body}
                  </p>
                ) : null}
              </article>
            )
          })}
        </div>
      </div>
    </main>
  )
}

/** Converts a question into display options, including true-false labels. */
function sessionOptions(
  question: SessionQuestion
): readonly { id: string; text: string }[] {
  if (question.type === "true-false")
    return [
      { id: "true", text: "True" },
      { id: "false", text: "False" },
    ]
  return question.options ?? []
}

/** Reports whether one option is currently selected in the session. */
function isOptionSelected(
  question: SessionQuestion,
  answer: SessionAnswer | undefined,
  optionId: string
): boolean {
  if (question.type === "multiple-answer")
    return Array.isArray(answer) && answer.includes(optionId)
  if (question.type === "true-false") return answer === (optionId === "true")
  return answer === optionId
}

/** Highlights the server-confirmed correct option after practice feedback. */
function optionIsCorrect(
  question: SessionQuestion,
  result: SessionAnswerResult | undefined,
  optionId: string
): boolean {
  if (!result?.feedback) return false
  if (question.type === "true-false")
    return result.feedback.correctAnswer === (optionId === "true")
  if (question.type === "single-choice")
    return result.feedback.correctOptionId === optionId
  return result.feedback.correctOptionIds?.includes(optionId) ?? false
}

/** Posts one answer through the route shared by browser and native clients. */
async function postAnswer(
  submission: ReturnType<typeof makeAnswerSubmission>,
  projectId: string
): Promise<SessionAnswerResult> {
  const response = await fetch("/api/learning/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      itemId: submission.itemId,
      clientEventId: submission.attemptId,
      occurredAt: submission.occurredAt,
      answer: submission.answer,
    }),
  })
  const body = (await response.json()) as unknown
  if (!response.ok) throw new Error(readError(body))
  if (!body || typeof body !== "object")
    throw new Error("Answer response is invalid")
  const result = body as Omit<SessionAnswerResult, "attemptId" | "itemId">
  return {
    ...result,
    attemptId: submission.attemptId,
    itemId: submission.itemId,
  }
}

/** Extracts a safe API error message from an unknown JSON response. */
function readError(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  )
    return body.error
  return "Learning service is unavailable"
}

/** Creates a stable-enough per-mount session identifier without a dependency. */
function createLocalSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID()
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`
}
