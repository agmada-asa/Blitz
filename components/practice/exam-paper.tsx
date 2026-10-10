"use client"

/**
 * A timed exam paper being sat: every question in order, a visible
 * countdown, and answers that autosave to the attempt so a reload resumes
 * where the learner left off. Submitting is confirmed when questions are
 * unanswered, and happens automatically when time runs out. Answers are
 * marked on the server; this screen never sees the answer key.
 */

import { useMutation } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LoadingIcon } from "@/components/ui/icon"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { MAX_WRITTEN_ANSWER_CHARS, type ExamAnswer } from "@/lib/exam-scoring"
import { cn } from "@/lib/utils"

/** The exam screen's data for one paper. */
type Session = NonNullable<FunctionReturnType<typeof api.exam.paperSession>>

/** A question as shown while the paper is sat, without its answer. */
type PaperQuestion = Session["questions"][number]

/** The attempt in progress. */
type ActiveAttempt = NonNullable<Session["active"]>

/** The learner's current answer to one question. */
type AnswerValue = { selected: string[]; text: string }

/** Answers keyed by question id. */
type AnswerState = Record<string, AnswerValue>

/** Delay after the last change before answers autosave. */
const AUTOSAVE_DELAY_MS = 800

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Restores saved answers into editable state. */
function initialAnswers(attempt: ActiveAttempt): AnswerState {
  const state: AnswerState = {}
  for (const answer of attempt.answers)
    state[answer.questionId] = {
      selected: answer.selectedOptionIds ?? [],
      text: answer.text ?? "",
    }
  return state
}

/** Converts editable answers into the saved shape, one entry per touched question. */
function toPayload(questions: PaperQuestion[], answers: AnswerState): ExamAnswer[] {
  return questions.flatMap((question): ExamAnswer[] => {
    const value = answers[question.id]
    if (!value) return []
    return question.type === "written"
      ? [{ questionId: question.id, text: value.text }]
      : [{ questionId: question.id, selectedOptionIds: value.selected }]
  })
}

/** Returns whether a question has an answer. */
function hasAnswer(question: PaperQuestion, value: AnswerValue | undefined): boolean {
  if (!value) return false
  return question.type === "written" ? Boolean(value.text.trim()) : value.selected.length > 0
}

/** Formats remaining time as m:ss, or h:mm:ss for an hour or more. */
function formatClock(milliseconds: number): string {
  const total = Math.ceil(milliseconds / 1_000)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

/** Returns the time warning to announce once, or an empty string. */
function timeWarning(milliseconds: number | null): string {
  if (milliseconds === null || milliseconds <= 0) return ""
  if (milliseconds <= 60_000) return "1 minute left."
  if (milliseconds <= 5 * 60_000) return "5 minutes left."
  if (milliseconds <= 10 * 60_000) return "10 minutes left."
  return ""
}

/**
 * Renders the paper and handles autosave, the countdown, and submission.
 * @param onSubmitted Called with the attempt ID once the server accepted the submission.
 */
export function ExamPaper({
  title,
  questions,
  attempt,
  onSubmitted,
}: {
  title: string
  questions: PaperQuestion[]
  attempt: ActiveAttempt
  onSubmitted: (attemptId: Id<"examAttempts">) => void
}) {
  const saveAnswers = useMutation(api.exam.saveAnswers)
  const [answers, setAnswers] = useState<AnswerState>(() => initialAnswers(attempt))
  // Counts the learner's changes; each one schedules an autosave.
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [now, setNow] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")

  // Ticks the countdown once a second; the first tick runs straight away.
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const interval = window.setInterval(tick, 1_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(interval)
    }
  }, [])

  const remaining = now === null ? null : Math.max(0, attempt.deadlineAt - now)
  const timeUp = remaining === 0
  const answeredCount = questions.filter((question) =>
    hasAnswer(question, answers[question.id])
  ).length
  const unanswered = questions.length - answeredCount
  const locked = submitting || timeUp

  // Keeps the latest answers for the autosave timer. The paper's question list
  // is a fresh array after every save, so it must not retrigger saving itself.
  const latest = useRef({ answers, questions })
  useEffect(() => {
    latest.current = { answers, questions }
  })

  // Autosaves shortly after the learner stops changing answers.
  useEffect(() => {
    if (!revision) return
    const timer = window.setTimeout(() => {
      setSaveState("saving")
      saveAnswers({
        attemptId: attempt.id,
        answers: toPayload(latest.current.questions, latest.current.answers),
      })
        .then((result) => setSaveState(result.saved ? "saved" : "idle"))
        .catch(() => setSaveState("error"))
    }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [attempt.id, revision, saveAnswers])

  /** Sends the final answers; the server marks them and records evidence. */
  const submit = useCallback(
    async (auto: boolean) => {
      setConfirming(false)
      setSubmitting(true)
      setSubmitError("")
      const response = await fetch("/api/practice/exam/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.id,
          answers: toPayload(questions, answers),
          auto,
        }),
      }).catch(() => null)
      if (!response?.ok) {
        const payload = (await response?.json().catch(() => null)) as { error?: unknown } | null
        setSubmitError(
          typeof payload?.error === "string"
            ? payload.error
            : "Your paper could not be submitted. Your answers are still here; try again."
        )
        setSubmitting(false)
        return
      }
      onSubmitted(attempt.id)
    },
    [answers, attempt.id, onSubmitted, questions]
  )

  // Submits automatically when time runs out, including on returning after the deadline.
  useEffect(() => {
    if (!timeUp || submitting || submitError) return
    const timer = window.setTimeout(() => void submit(true), 0)
    return () => window.clearTimeout(timer)
  }, [submit, submitError, submitting, timeUp])

  /** Updates one question's answer and schedules an autosave. */
  function change(questionId: string, value: Partial<AnswerValue>) {
    if (locked) return
    setAnswers((current) => ({
      ...current,
      [questionId]: { ...(current[questionId] ?? { selected: [], text: "" }), ...value },
    }))
    setRevision((count) => count + 1)
  }

  /** Asks for confirmation when questions are unanswered, otherwise submits. */
  function requestSubmit() {
    if (locked) return
    if (unanswered) setConfirming(true)
    else void submit(false)
  }

  const warning = timeWarning(remaining)
  const saveText =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Answers saved" : ""

  return (
    <>
      <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {answeredCount} of {questions.length} answered
              {saveText ? ` · ${saveText}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p
              role="timer"
              aria-live="off"
              className={cn(
                "font-heading text-lg font-semibold tabular-nums",
                remaining !== null && remaining <= 5 * 60_000 && "text-destructive"
              )}
            >
              <span className="sr-only">Time left: </span>
              {remaining === null ? "…" : formatClock(remaining)}
            </p>
            <Button
              type="button"
              disabled={locked}
              onClick={requestSubmit}
              className="min-h-10 rounded-full bg-brand px-4 text-brand-foreground hover:bg-brand/85"
            >
              Submit
            </Button>
          </div>
        </div>
        {saveState === "error" ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            Answers could not be saved. Check your connection; they stay on this page and are sent
            when you submit.
          </p>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {warning}
      </p>

      {timeUp || submitting || submitError ? (
        <div
          role={submitError ? "alert" : "status"}
          className={cn(
            "mt-4 rounded-xl border p-4 text-sm",
            submitError ? "border-destructive/40 text-destructive" : "border-border"
          )}
        >
          {submitError ? (
            <>
              <p>{submitError}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void submit(timeUp)}
                className="mt-3 min-h-10 rounded-full px-4"
              >
                Try again
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
              {timeUp ? "Time's up. Submitting your paper…" : "Submitting your paper…"}
            </p>
          )}
        </div>
      ) : null}

      <ol className="mt-6 space-y-5" aria-label="Questions">
        {questions.map((question) => (
          <li key={question.id}>
            <QuestionField
              question={question}
              value={answers[question.id]}
              disabled={locked}
              onChange={(value) => change(question.id, value)}
            />
          </li>
        ))}
      </ol>

      <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          disabled={locked}
          onClick={requestSubmit}
          className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
        >
          Submit paper
        </Button>
        <p className="text-xs text-muted-foreground">
          {unanswered ? `${plural(unanswered, "question")} unanswered.` : "Every question answered."}
        </p>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit with {plural(unanswered, "question")} unanswered?</DialogTitle>
            <DialogDescription>
              Unanswered questions get no marks. You can&apos;t change your answers after
              submitting.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-full px-5"
            >
              Keep working
            </Button>
            <Button
              type="button"
              onClick={() => void submit(false)}
              className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
            >
              Submit paper
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Shared row styling for an option, highlighted when chosen. */
const optionRow =
  "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm leading-5 hover:bg-muted has-[[data-state=checked]]:border-brand/60 has-[[data-state=checked]]:bg-brand/10 has-[:disabled]:cursor-default"

/** One question with the input that fits its type. */
function QuestionField({
  question,
  value,
  disabled,
  onChange,
}: {
  question: PaperQuestion
  value: AnswerValue | undefined
  disabled: boolean
  onChange: (value: Partial<AnswerValue>) => void
}) {
  const labelId = `${question.id}-label`
  const promptId = `${question.id}-prompt`
  const hintId = `${question.id}-hint`
  const selected = value?.selected ?? []
  const lettered = question.type !== "true-false"

  return (
    <section
      aria-labelledby={labelId}
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={labelId} className="text-sm font-semibold">
          Question {question.number}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {plural(question.marks, "mark")}
        </span>
      </div>
      <div id={promptId} className="mt-2 min-w-0 text-sm">
        {plainMarkdownRenderer(question.prompt)}
      </div>

      {question.type === "written" ? (
        <div className="mt-3">
          <Textarea
            aria-labelledby={`${labelId} ${promptId}`}
            value={value?.text ?? ""}
            maxLength={MAX_WRITTEN_ANSWER_CHARS}
            disabled={disabled}
            onChange={(event) => onChange({ text: event.target.value })}
            placeholder="Write your answer"
            className="min-h-40"
          />
          {(value?.text.length ?? 0) > MAX_WRITTEN_ANSWER_CHARS * 0.8 ? (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {value?.text.length ?? 0} of {MAX_WRITTEN_ANSWER_CHARS} characters
            </p>
          ) : null}
        </div>
      ) : question.type === "multiple-answer" ? (
        <div role="group" aria-labelledby={`${labelId} ${promptId}`} aria-describedby={hintId}>
          <p id={hintId} className="mt-2 text-xs text-muted-foreground">
            Choose all that apply.
          </p>
          <div className="mt-2 grid gap-2">
            {question.options.map((option, index) => {
              const id = `${question.id}-${option.id}`
              return (
                <label key={option.id} htmlFor={id} className={optionRow}>
                  <Checkbox
                    id={id}
                    checked={selected.includes(option.id)}
                    disabled={disabled}
                    aria-labelledby={`${id}-text`}
                    onCheckedChange={(checked) =>
                      onChange({
                        selected: question.options
                          .map((entry) => entry.id)
                          .filter((entryId) =>
                            entryId === option.id ? checked === true : selected.includes(entryId)
                          ),
                      })
                    }
                  />
                  <span aria-hidden="true" className="text-xs text-muted-foreground">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span id={`${id}-text`} className="min-w-0 flex-1">
                    {plainMarkdownRenderer(option.text, { inline: true })}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      ) : (
        <>
          <RadioGroup
            value={selected[0] ?? ""}
            onValueChange={(next) => onChange({ selected: [next] })}
            disabled={disabled}
            aria-labelledby={`${labelId} ${promptId}`}
            className="mt-3 grid gap-2"
          >
            {question.options.map((option, index) => {
              const id = `${question.id}-${option.id}`
              return (
                <label key={option.id} htmlFor={id} className={optionRow}>
                  <RadioGroupItem id={id} value={option.id} aria-labelledby={`${id}-text`} />
                  {lettered ? (
                    <span aria-hidden="true" className="text-xs text-muted-foreground">
                      {String.fromCharCode(65 + index)}
                    </span>
                  ) : null}
                  <span id={`${id}-text`} className="min-w-0 flex-1">
                    {plainMarkdownRenderer(option.text, { inline: true })}
                  </span>
                </label>
              )
            })}
          </RadioGroup>
          {selected.length > 0 && !disabled ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ selected: [] })}
              className="mt-2 min-h-9 px-2 text-xs text-muted-foreground"
            >
              Clear answer
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}
