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
import { CancelIcon, CheckIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
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
  const [startedAt, setStartedAt] = useState(() => Date.now())
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
  const [testStarted, setTestStarted] = useState(false)
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

  /** Starts the test timer only after the learner chooses to begin. */
  function startTest(): void {
    setStartedAt(Date.now())
    setTestStarted(true)
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
        answers={testAnswers}
        progress={progress}
        projectId={projectId}
      />
    )
  if (mode === "test" && !testStarted)
    return (
      <TestSetup
        projectId={projectId}
        questionCount={questions.length}
        onStart={startTest}
      />
    )
  if (mode === "practice" && complete)
    return (
      <SessionStatus
        message="Questions complete."
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
    <main className="flex min-h-svh flex-col bg-background font-sans text-foreground selection:bg-brand selection:text-brand-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5 sm:px-8">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-10 px-3.5 text-sm"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>Exit</Link>
        </Button>
        <p className="text-xs text-muted-foreground">
          {mode === "practice" ? "Questions" : "Test"} · {currentIndex + 1} of {questions.length}
          {mode === "test" ? " · Results at the end" : ""}
        </p>
        <span className="w-12" aria-hidden="true" />
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 pb-12 sm:px-8">
        <h1 className="max-w-[620px] text-[clamp(1.8rem,6vw,3rem)] leading-[1.05] font-medium tracking-[-0.04em]">
          {question.prompt}
        </h1>

        {question.type === "multiple-answer" ? (
          <p className="mt-4 text-sm text-muted-foreground">Select all that apply</p>
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
                aria-label={sessionOptionLabel(
                  option.text,
                  selected,
                  practiceResult,
                  correct
                )}
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
                className={sessionOptionClass(
                  practiceResult,
                  selected,
                  correct
                )}
              >
                {practiceResult?.feedback && correct ? (
                  <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
                ) : practiceResult?.feedback && selected ? (
                  <CancelIcon aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
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

        <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
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
              <Button onClick={advance} disabled={submitting}>
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

/** Shows the number of loaded test questions before starting the timed session. */
function TestSetup({
  projectId,
  questionCount,
  onStart,
}: {
  projectId: string
  questionCount: number
  onStart: () => void
}) {
  return (
    <main className="flex min-h-svh flex-col bg-background px-5 py-5 font-sans text-foreground sm:px-8 sm:py-6">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between border-b border-border pb-3">
        <h1 className="text-sm font-medium">Test</h1>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>Exit</Link>
        </Button>
      </header>
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-0 pb-12">
        <h2 className="font-heading text-3xl font-medium tracking-tight">
          {questionCount} questions
        </h2>
        <Button onClick={onStart} className="mt-6 min-h-11 w-fit">
          Start test
        </Button>
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
    <main className="flex min-h-svh items-center justify-center bg-background px-5 text-center font-sans text-foreground">
      <div className="max-w-md space-y-5">
      <p className="text-sm text-muted-foreground">{message}</p>
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
          ? "text-sm font-medium text-emerald-600 dark:text-emerald-300"
          : "text-sm font-medium text-destructive"
        }
      >
        {result.status === "correct"
          ? "Correct"
          : result.status === "incorrect"
            ? "Incorrect"
            : "Answer could not be scored"}
      </p>
      {result.feedback?.body ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
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
  answers,
  progress,
  projectId,
}: {
  questions: readonly SessionQuestion[]
  results: Readonly<Record<string, SessionAnswerResult | undefined>>
  answers: Readonly<Record<string, SessionAnswer | undefined>>
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
    <main className="min-h-svh bg-background px-5 py-8 font-sans text-foreground sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-10 px-3.5 text-sm"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>Exit</Link>
        </Button>
        <h1 className="mt-8 text-3xl font-medium tracking-tight">
          Test results
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {summary.correct} correct · {summary.incorrect} incorrect ·{" "}
          {summary.unanswered} unanswered
        </p>
        <div className="mt-10 space-y-7">
          {questions.map((question) => {
            const result = results[question.itemId]
            return (
              <article
                key={question.itemId}
                className="border-t border-border py-4"
              >
                <h2 className="font-medium">{question.prompt}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {result
                    ? result.status === "correct"
                      ? "Correct"
                      : result.status === "incorrect"
                        ? "Incorrect"
                        : "Could not score this answer"
                    : "Unanswered"}
                </p>
                {result ? (
                  <div
                    className="mt-4 space-y-2"
                    role={
                      question.type === "multiple-answer"
                        ? "group"
                        : "radiogroup"
                    }
                    aria-label="Answer options"
                  >
                    {sessionOptions(question).map((option) => {
                      const selected = isOptionSelected(
                        question,
                        answers[question.itemId],
                        option.id
                      )
                      const correct = optionIsCorrect(
                        question,
                        result,
                        option.id
                      )
                      return (
                        <div
                          key={option.id}
                          role={
                            question.type === "multiple-answer"
                              ? "checkbox"
                              : "radio"
                          }
                          aria-checked={selected}
                          aria-disabled="true"
                          aria-label={sessionOptionLabel(
                            option.text,
                            selected,
                            result,
                            correct
                          )}
                          className={sessionOptionClass(
                            result,
                            selected,
                            correct
                          )}
                        >
                          {result.feedback && correct ? (
                            <CheckIcon
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                          ) : result.feedback && selected ? (
                            <CancelIcon
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                          ) : null}
                          <span>{option.text}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {result?.feedback?.body ? (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {result.feedback.body}
                  </p>
                ) : null}
              </article>
            )
          })}
        </div>
        <Button asChild className="mt-7">
          <Link href={`/projects/${encodeURIComponent(projectId)}/practice`}>
            Back to Practice
          </Link>
        </Button>
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

/** Applies neutral, selected, and post-score option states consistently. */
function sessionOptionClass(
  result: SessionAnswerResult | undefined,
  selected: boolean,
  correct: boolean
): string {
  const showFeedback = Boolean(result?.feedback)
  return cn(
    "flex h-auto min-h-14 w-full cursor-pointer items-center justify-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm whitespace-normal text-card-foreground transition-colors hover:border-brand/50 hover:bg-brand/10 disabled:cursor-default disabled:opacity-100",
    selected &&
      !showFeedback &&
      "border-brand/70 bg-brand/15 text-foreground hover:border-brand/80 hover:bg-brand/25",
    showFeedback &&
      correct &&
      "border-emerald-500/60 bg-emerald-500/10 text-foreground",
    showFeedback &&
      selected &&
      !correct &&
      "border-destructive/60 bg-destructive/10 text-foreground"
  )
}

/** Gives assistive technology the same answer state shown by the color and icon. */
function sessionOptionLabel(
  text: string,
  selected: boolean,
  result: SessionAnswerResult | undefined,
  correct: boolean
): string {
  if (!result?.feedback) return text
  if (correct) return `${text}, correct answer`
  if (selected) return `${text}, your answer was incorrect`
  return text
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
