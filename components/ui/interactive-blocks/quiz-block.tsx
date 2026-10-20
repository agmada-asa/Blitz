"use client"

/**
 * Renders an inline quiz from a ```quiz Markdown block.
 *
 * Single-choice and true-false questions submit as soon as an option is chosen; multiple-answer
 * questions use checkboxes and a `Check answer` button. Cloze, ordering, matching, and code-output
 * questions use `StructuredAnswer` and also submit with `Check answer`. Answers are scored by the provider's
 * `onQuizAnswer` handler when present (falling back to local grading when it returns null) and shown
 * with icons and text, the explanation, and `Try again` for incorrect answers. A freshly checked answer
 * also plays a short pulse or shake and buzzes phones (see `answer-feedback.ts`). Recorded answers from
 * the provider restore the answered state after a reload.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import {
  clozeDisplayText,
  gradeQuizAnswer,
  initialStructuredAnswer,
  isChoiceQuiz,
  structuredAnswerReady,
  type QuizBlock,
} from "@/lib/interactive-blocks"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  CancelIcon,
  CheckCircleIcon,
  LoadingIcon,
  RotateLeftIcon,
} from "@/components/ui/icon"
import {
  useInteractiveBlocks,
  type MarkdownRenderer,
} from "@/components/ui/interactive-blocks/context"
import {
  answerCueClass,
  vibrateForAnswer,
  type AnswerCue,
} from "@/components/ui/interactive-blocks/answer-feedback"
import { QuizSaveAction } from "@/components/ui/interactive-blocks/quiz-save"
import {
  StructuredAnswer,
  structuredHints,
} from "@/components/ui/interactive-blocks/structured-answer"

/** Progress of the learner's current attempt. */
type QuizAttempt =
  | { status: "idle"; selected: string[] }
  | { status: "pending"; selected: string[] }
  | { status: "answered"; selected: string[]; correct: boolean }
  | { status: "error"; selected: string[] }

/** How one option is marked once the quiz is answered. */
type OptionMark = "correct-selected" | "incorrect-selected" | "correct-missed"

/** Visible instruction under the question for each quiz type. */
const quizHints: Record<QuizBlock["type"], string> = {
  "single-choice": "Choose one answer.",
  "multiple-answer": "Choose all that apply.",
  "true-false": "Choose true or false.",
  ...structuredHints,
}

/** Visible text and screen reader text for each answered option mark. */
const markLabels: Record<OptionMark, string> = {
  "correct-selected": "Your answer, correct",
  "incorrect-selected": "Your answer, incorrect",
  "correct-missed": "Correct answer",
}

/**
 * Determines how an option is marked after answering.
 * @param block The quiz.
 * @param attempt Current attempt; options are only marked once answered.
 * @param optionId Option to mark.
 * @returns The mark, or undefined for unmarked options and unanswered quizzes.
 */
function optionMark(
  block: QuizBlock,
  attempt: QuizAttempt,
  optionId: string
): OptionMark | undefined {
  if (attempt.status !== "answered") return undefined
  const correct = block.correctOptionIds.includes(optionId)
  const selected = attempt.selected.includes(optionId)
  if (selected) return correct ? "correct-selected" : "incorrect-selected"
  return correct ? "correct-missed" : undefined
}

/**
 * Shows an answered option's mark as an icon with visible text so it never relies on colour alone.
 * @param id Optional element id so a control can reference the label.
 * @param mark Mark for the option.
 * @returns A compact status label.
 */
function OptionMarkLabel({ id, mark }: { id?: string; mark: OptionMark }) {
  const correct = mark !== "incorrect-selected"
  const Icon = correct ? CheckCircleIcon : CancelIcon
  return (
    <span
      id={id}
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 text-xs font-medium",
        correct ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
      )}
    >
      <Icon size={15} aria-hidden="true" />
      {markLabels[mark]}
    </span>
  )
}

/** Shared row styling for options; answered marks add a tinted border. */
function optionRowClass(mark: OptionMark | undefined, highlighted: boolean) {
  return cn(
    "flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm leading-5 font-normal whitespace-normal",
    highlighted && "border-brand/60 bg-brand/10",
    (mark === "correct-selected" || mark === "correct-missed") &&
      "border-emerald-500/45 bg-emerald-500/[0.06]",
    mark === "incorrect-selected" &&
      "border-destructive/45 bg-destructive/[0.06]"
  )
}

/**
 * Renders one interactive quiz.
 * @param block Validated quiz block.
 * @param renderMarkdown Renders the question, options, and explanation as non-interactive Markdown.
 * @returns The quiz with its options, feedback, and recovery actions.
 */
export function QuizBlockView({
  block,
  renderMarkdown,
}: {
  block: QuizBlock
  renderMarkdown: MarkdownRenderer
}) {
  const { onQuizAnswer, answeredQuizzes, quizSaving, streaming } =
    useInteractiveBlocks()
  const baseId = useId()
  const questionId = `${baseId}-question`
  const hintId = `${baseId}-hint`
  const optionsRef = useRef<HTMLDivElement>(null)
  const feedbackRef = useRef<HTMLDivElement>(null)
  const focusFirstOption = useRef(false)
  // Undefined until the learner acts, so a recorded answer that loads later still appears.
  const [localAttempt, setLocalAttempt] = useState<QuizAttempt>()

  const recorded = answeredQuizzes?.[block.id]
  const validIds = new Set(block.options.map((option) => option.id))
  const structured = !isChoiceQuiz(block.type)
  /** The attempt a new or retried question starts from. */
  const freshAttempt = (): QuizAttempt => ({
    status: "idle",
    selected: structured ? initialStructuredAnswer(block) : [],
  })
  const attempt: QuizAttempt =
    localAttempt ??
    (recorded
      ? {
          status: "answered",
          // Structured answers are typed or arranged values, not option ids.
          selected: structured
            ? recorded.selectedOptionIds
            : recorded.selectedOptionIds.filter((id) => validIds.has(id)),
          correct: recorded.correct,
        }
      : freshAttempt())
  const multiple = block.type === "multiple-answer"
  // Formats that collect an answer first and check it with a button.
  const checked = multiple || structured
  const locked = attempt.status === "pending" || attempt.status === "answered"
  // The cue plays only for an answer checked in this view, so a recorded answer does not replay on load.
  const cue: AnswerCue | undefined =
    localAttempt?.status === "answered"
      ? localAttempt.correct
        ? "correct"
        : "wrong"
      : undefined

  /**
   * Scores a selection with the provider handler, falling back to local grading when it returns null
   * or no handler exists. A thrown handler error leaves the selection in a retryable error state.
   * @param selected Option ids to submit.
   */
  async function submit(selected: string[]) {
    if (attempt.status === "pending" || selected.length === 0) return
    if (structured && !structuredAnswerReady(block.type, selected)) return
    setLocalAttempt({ status: "pending", selected })
    try {
      const result = onQuizAnswer ? await onQuizAnswer(block, selected) : null
      const correct = result ? result.correct : gradeQuizAnswer(block, selected)
      setLocalAttempt({ status: "answered", selected, correct })
      vibrateForAnswer(correct)
    } catch {
      setLocalAttempt({ status: "error", selected })
    }
    // The Check answer button disappears after a checked submission, so keep focus nearby.
    if (checked) feedbackRef.current?.focus()
  }

  // After Try again, the button disappears, so focus moves to the first option once it is unlocked.
  useEffect(() => {
    if (!focusFirstOption.current || attempt.status !== "idle") return
    focusFirstOption.current = false
    optionsRef.current
      ?.querySelector<HTMLElement>(
        "[data-quiz-option], input, textarea, button:not(:disabled)"
      )
      ?.focus()
  }, [attempt.status])

  /** Starts a new attempt and returns focus to the first option. */
  function tryAgain() {
    focusFirstOption.current = true
    setLocalAttempt(freshAttempt())
  }

  /**
   * Adds or removes a multiple-answer option before checking.
   * @param optionId Option to toggle.
   * @param checked Whether the option is now selected.
   */
  function toggle(optionId: string, checked: boolean) {
    if (locked) return
    // Functional update so rapid toggles in one frame all apply.
    setLocalAttempt((current) => {
      // An answered attempt never reaches here (it is locked); an error keeps its selection.
      const previous =
        current && current.status !== "answered" ? current.selected : []
      const selected = checked
        ? [...previous, optionId]
        : previous.filter((id) => id !== optionId)
      // Keep option order stable regardless of click order.
      return {
        status: "idle",
        selected: block.options
          .map((option) => option.id)
          .filter((id) => selected.includes(id)),
      }
    })
  }

  /**
   * Moves focus between single-choice options with arrow, Home, and End keys without submitting,
   * because choosing an option submits the answer.
   * @param event Key event from the option group.
   */
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const options = [
      ...(optionsRef.current?.querySelectorAll<HTMLElement>(
        "[data-quiz-option]"
      ) ?? []),
    ]
    const current = options.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (current + 1) % options.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (current - 1 + options.length) % options.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : undefined
    if (next === undefined) return
    event.preventDefault()
    options[next]?.focus()
  }

  return (
    <section
      className="interactive-block rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-labelledby={questionId}
      data-quiz-id={block.id}
    >
      <fieldset className="min-w-0" aria-describedby={hintId}>
        <legend className="w-full">
          <span className="block text-xs font-medium text-muted-foreground">
            {block.concept}
          </span>
          <span id={questionId} className="mt-1 block font-medium">
            {structured
              ? // Structured prompts often hold code blocks, so they render as full Markdown.
                renderMarkdown(
                  block.type === "cloze"
                    ? clozeDisplayText(block.question)
                    : block.question
                )
              : renderMarkdown(block.question, { inline: true })}
          </span>
        </legend>
        <p id={hintId} className="mt-1 text-sm text-muted-foreground">
          {quizHints[block.type]}
        </p>

        {structured ? (
          <div
            ref={optionsRef}
            className="mt-3"
            aria-busy={attempt.status === "pending"}
          >
            <StructuredAnswer
              shape={block}
              value={attempt.selected}
              onChange={(selected) => {
                if (!locked) setLocalAttempt({ status: "idle", selected })
              }}
              disabled={locked}
              answerKey={attempt.status === "answered" ? block : undefined}
              correct={
                attempt.status === "answered" ? attempt.correct : undefined
              }
              cue={cue}
              renderMarkdown={renderMarkdown}
              idBase={baseId}
            />
          </div>
        ) : (
          <div
            ref={optionsRef}
            className="mt-3 grid gap-2"
            aria-busy={attempt.status === "pending"}
            onKeyDown={multiple ? undefined : moveFocus}
          >
            {block.options.map((option, index) => {
              const mark = optionMark(block, attempt, option.id)
              const selected = attempt.selected.includes(option.id)
              const pendingChoice = attempt.status === "pending" && selected
              const marker =
                block.type === "true-false"
                  ? null
                  : String.fromCharCode(65 + index)

              if (multiple) {
                const checkboxId = `${baseId}-option-${option.id}`
                return (
                  <label
                    key={option.id}
                    htmlFor={checkboxId}
                    className={cn(
                      optionRowClass(mark, false),
                      selected && answerCueClass(cue),
                      locked
                        ? "cursor-default"
                        : "cursor-pointer hover:bg-muted"
                    )}
                  >
                    <Checkbox
                      id={checkboxId}
                      data-quiz-option=""
                      checked={selected}
                      disabled={locked}
                      // Radix renders a button, so name it explicitly from the option text and mark.
                      aria-labelledby={`${checkboxId}-text`}
                      aria-describedby={mark ? `${checkboxId}-mark` : undefined}
                      onCheckedChange={(checked) =>
                        toggle(option.id, checked === true)
                      }
                    />
                    <span id={`${checkboxId}-text`} className="min-w-0 flex-1">
                      {renderMarkdown(option.text, { inline: true })}
                    </span>
                    {mark ? (
                      <OptionMarkLabel id={`${checkboxId}-mark`} mark={mark} />
                    ) : null}
                  </label>
                )
              }

              return (
                <Button
                  key={option.id}
                  type="button"
                  variant="ghost"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={locked}
                  data-quiz-option=""
                  onClick={() => {
                    if (!locked) void submit([option.id])
                  }}
                  className={cn(
                    "h-auto",
                    optionRowClass(mark, pendingChoice),
                    selected && answerCueClass(cue),
                    locked && "pointer-events-none"
                  )}
                >
                  {marker || pendingChoice ? (
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground"
                      aria-hidden="true"
                    >
                      {pendingChoice ? (
                        <LoadingIcon size={15} className="animate-spin" />
                      ) : (
                        marker
                      )}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    {renderMarkdown(option.text, { inline: true })}
                  </span>
                  {mark ? <OptionMarkLabel mark={mark} /> : null}
                </Button>
              )
            })}
          </div>
        )}
      </fieldset>

      {checked && !locked ? (
        <Button
          type="button"
          className="mt-3 h-11 px-4 sm:h-9"
          disabled={
            structured
              ? !structuredAnswerReady(block.type, attempt.selected)
              : attempt.selected.length === 0
          }
          onClick={() => void submit(attempt.selected)}
        >
          Check answer
        </Button>
      ) : null}

      <div
        ref={feedbackRef}
        tabIndex={-1}
        className="space-y-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring has-[>p:not(:empty)]:mt-3"
      >
        <p
          role="status"
          className={cn(
            "flex items-center gap-2 text-sm font-medium empty:hidden",
            attempt.status === "answered" &&
              (attempt.correct
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-destructive"),
            attempt.status === "error" && "text-destructive",
            attempt.status === "pending" && "text-muted-foreground"
          )}
        >
          {attempt.status === "pending" ? (
            <>
              <LoadingIcon
                size={15}
                className="animate-spin"
                aria-hidden="true"
              />
              Checking your answer…
            </>
          ) : attempt.status === "answered" ? (
            <>
              {attempt.correct ? (
                <CheckCircleIcon size={16} aria-hidden="true" />
              ) : (
                <CancelIcon size={16} aria-hidden="true" />
              )}
              {attempt.correct ? "Correct" : "Incorrect"}
            </>
          ) : attempt.status === "error" ? (
            "Your answer couldn't be checked. Try again."
          ) : null}
        </p>

        {attempt.status === "answered" && block.explanation ? (
          <div className="text-sm">{renderMarkdown(block.explanation)}</div>
        ) : null}

        {attempt.status === "answered" && !attempt.correct ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 px-4 sm:h-9"
            onClick={tryAgain}
          >
            <RotateLeftIcon aria-hidden="true" />
            Try again
          </Button>
        ) : null}

        {attempt.status === "error" ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 px-4 sm:h-9"
            onClick={() => void submit(attempt.selected)}
          >
            <RotateLeftIcon aria-hidden="true" />
            Try again
          </Button>
        ) : null}
      </div>
      {quizSaving && !streaming ? (
        <QuizSaveAction quizId={block.id} saving={quizSaving} />
      ) : null}
    </section>
  )
}
