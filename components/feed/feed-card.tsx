"use client"

/**
 * Renders one server-backed Review card and owns its answer selection and feedback state. The card
 * sits in the same bordered frame and option rows as `QuizBlockView`, so Review questions look like
 * drill and Teach questions, with Next, Ask in chat and Skip below it. Number keys, letters, and
 * Enter answer the card or move on once it is answered (see `hooks/use-quiz-shortcuts.ts`).
 * About half the single-choice questions start as recall: the learner answers in their head, reveals
 * the answer, and grades themselves, or shows the options instead (see `lib/learning/recall.ts`).
 */

import { useId, useRef, useState } from "react"

import type {
  AnswerResponse,
  FeedCard,
  FeedOption,
  LearningAnswer,
  RecallReveal,
} from "@/lib/learning/client-contracts"
import { startsAsRecall } from "@/lib/learning/recall"
import { Button } from "@/components/ui/button"
import { ArrowRightIcon, CancelIcon, ChatIcon, CheckCircleIcon } from "@/components/ui/icon"
import { GuessToggle } from "@/components/ui/interactive-blocks/guess-toggle"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
import { useQuizShortcuts } from "@/hooks/use-quiz-shortcuts"
import {
  answerCueClass,
  vibrateForAnswer,
  type AnswerCue,
} from "@/components/ui/interactive-blocks/answer-feedback"
import {
  StructuredAnswer,
  structuredHints,
} from "@/components/ui/interactive-blocks/structured-answer"
import {
  clozeDisplayText,
  initialStructuredAnswer,
  isChoiceQuiz,
  structuredAnswerReady,
  type StructuredAnswerShape,
} from "@/lib/interactive-blocks"
import { cn } from "@/lib/utils"

/** Props required to render one card in the Review feed. */
type FeedCardProps = {
  card: FeedCard
  /** Where the card comes from, such as "SWE · Week 7 slides", shown above it. */
  context: string
  onAsk: (card: FeedCard) => void
  /** Moves on: Next once answered, Got it on a recap, or Skip before answering. */
  onNext: (card: FeedCard) => void
  onAnswer: (
    card: FeedCard,
    answer: LearningAnswer,
    confidence?: "guess"
  ) => Promise<AnswerResponse>
  /** Reveals a question's answer for recall without recording anything. */
  onReveal: (card: FeedCard) => Promise<RecallReveal>
  /** Records the learner's own verdict on a recalled answer. */
  onRecall: (card: FeedCard, knewIt: boolean) => Promise<void>
}

/** Where a recall-first question stands. */
type RecallState =
  | { step: "thinking" }
  | { step: "revealing" }
  | { step: "revealed"; reveal: RecallReveal }
  | { step: "graded"; reveal: RecallReveal; knewIt: boolean }

/** Renders a server-backed explanation or question card. */
export function FeedCardView({
  card,
  context,
  onAsk,
  onNext,
  onAnswer,
  onReveal,
  onRecall,
}: FeedCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedMany, setSelectedMany] = useState<string[]>([])
  const [feedback, setFeedback] = useState<AnswerResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [guessing, setGuessing] = useState(false)
  // Null once the learner chose the options, or for questions not asked from memory.
  const [recall, setRecall] = useState<RecallState | null>(() =>
    card.type !== "explain" && startsAsRecall(card) ? { step: "thinking" } : null
  )
  const cardRef = useRef<HTMLElement>(null)
  const isMultipleAnswer = card.type === "multiple-answer"
  const idBase = useId()
  const structured = card.type !== "explain" && !isChoiceQuiz(card.type)
  const shape: StructuredAnswerShape | null =
    card.type !== "explain" && structured
      ? {
          type: card.type,
          question: card.question,
          options: card.options ?? [],
          prompts: card.prompts,
        }
      : null
  const [structuredValue, setStructuredValue] = useState<string[]>(() =>
    shape ? initialStructuredAnswer(shape) : []
  )
  // Plays once per checked answer; feedback only ever comes from this card's own submission.
  const cue: AnswerCue | undefined = feedback
    ? feedback.isCorrect
      ? "correct"
      : "wrong"
    : undefined
  // Enter moves on once answered; explanations have no answer to check.
  useQuizShortcuts(cardRef, {
    answerable: !pending && !feedback && !recall && card.type !== "explain",
    lettered: card.type !== "true-false",
    onAdvance:
      feedback || recall?.step === "graded" ? () => onNext(card) : undefined,
  })
  // Cloze blanks show as numbered gaps; every other prompt shows as written.
  const prompt =
    card.type === "explain"
      ? card.title
      : card.type === "cloze"
        ? clozeDisplayText(card.question)
        : card.question

  /** Sends one selected answer for server scoring and keeps failure recoverable. */
  async function submitAnswer(answer: LearningAnswer) {
    if (pending || feedback) return
    setPending(true)
    setError("")
    try {
      const result = await onAnswer(card, answer, guessing ? "guess" : undefined)
      if (result.status === "invalid") {
        setError("That answer could not be checked. Try again.")
        setFeedback(null)
      } else {
        setFeedback(result)
        vibrateForAnswer(result.isCorrect)
      }
    } catch {
      setError("Could not check that answer. Try again.")
      setFeedback(null)
    } finally {
      setPending(false)
    }
  }

  /** Shows the answer to a question being recalled from memory. */
  async function reveal() {
    if (recall?.step !== "thinking") return
    setRecall({ step: "revealing" })
    setError("")
    try {
      setRecall({ step: "revealed", reveal: await onReveal(card) })
    } catch {
      setRecall({ step: "thinking" })
      setError("Could not show the answer. Try again, or show the options.")
    }
  }

  /** Records whether the learner knew the revealed answer. */
  async function grade(knewIt: boolean) {
    if (recall?.step !== "revealed" || pending) return
    setPending(true)
    setError("")
    try {
      await onRecall(card, knewIt)
      setRecall({ step: "graded", reveal: recall.reveal, knewIt })
      vibrateForAnswer(knewIt)
    } catch {
      setError("Could not save that. Try again.")
    } finally {
      setPending(false)
    }
  }

  /** Selects one choice and immediately asks the server to score it. */
  function selectChoice(optionId: string) {
    setSelected(optionId)
    setFeedback(null)
    void submitAnswer(answerForOption(optionId))
  }

  /** Toggles a multiple-answer choice without scoring until submission. */
  function toggleChoice(optionId: string) {
    setFeedback(null)
    setError("")
    setSelectedMany((current) =>
      current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
    )
  }

  /** Submits the selected multiple-answer set to the server. */
  function submitMultiple() {
    if (!selectedMany.length) return
    void submitAnswer(selectedMany)
  }

  /** Returns the options displayed for a card, including true/false choices. */
  function optionsForCard(): FeedOption[] {
    if (card.type === "true-false") {
      return [
        { id: "true", text: "True" },
        { id: "false", text: "False" },
      ]
    }
    return card.options ?? []
  }

  /** Converts a displayed option into the answer value expected by the API. */
  function answerForOption(optionId: string): LearningAnswer {
    if (card.type === "true-false") return optionId === "true"
    return optionId
  }

  /** Checks whether one option should be highlighted from server-owned feedback. */
  function optionIsCorrect(optionId: string): boolean {
    if (!feedback?.feedback) return false
    if (card.type === "true-false") {
      return feedback.feedback.correctAnswer === (optionId === "true")
    }
    if (card.type === "single-choice") {
      return feedback.feedback.correctOptionId === optionId
    }
    return feedback.feedback.correctOptionIds?.includes(optionId) ?? false
  }

  /** Returns the visual state for one answer option after server feedback. */
  function optionClass(optionId: string, isSelected: boolean) {
    const showFeedback = feedback !== null
    // Matches the option rows in `QuizBlockView`, so feed, drill and Teach questions look alike.
    return cn(
      "flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm leading-5 text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default",
      isSelected && !showFeedback && "border-brand/60 bg-brand/10",
      showFeedback &&
        optionIsCorrect(optionId) &&
        "border-emerald-500/45 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.06]",
      showFeedback &&
        isSelected &&
        !optionIsCorrect(optionId) &&
        "border-destructive/45 bg-destructive/[0.06] hover:bg-destructive/[0.06]",
      showFeedback && isSelected && answerCueClass(cue)
    )
  }

  const handled = Boolean(feedback) || recall?.step === "graded"

  return (
    <article ref={cardRef} data-quiz-scope="" aria-label={card.title}>
      <p className="mb-3 truncate text-xs text-muted-foreground">{context}</p>
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        {card.type === "explain" ? (
          <p className="text-xs font-medium text-brand">Recap</p>
        ) : (
          <p className="text-xs font-medium text-muted-foreground">{card.title}</p>
        )}
        {/* Questions may hold code blocks, so those render as Markdown blocks. */}
        {card.type !== "explain" && prompt.includes("```") ? (
          <div className="mt-1 font-medium">{plainMarkdownRenderer(prompt)}</div>
        ) : (
          <h2 className="mt-1 font-medium">{plainMarkdownRenderer(prompt, { inline: true })}</h2>
        )}

        {card.type === "explain" ? (
          <div className="mt-2 text-base leading-relaxed text-muted-foreground">
            {plainMarkdownRenderer(card.body)}
          </div>
        ) : shape ? (
          <>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {structuredHints[shape.type as keyof typeof structuredHints]}
              </p>
              {!feedback ? (
                <GuessToggle pressed={guessing} onPressedChange={setGuessing} />
              ) : null}
            </div>
            <div className="mt-3" aria-busy={pending}>
              <StructuredAnswer
                shape={shape}
                value={structuredValue}
                onChange={setStructuredValue}
                disabled={pending || feedback !== null}
                answerKey={feedback?.feedback}
                correct={feedback ? feedback.isCorrect : undefined}
                cue={cue}
                renderMarkdown={plainMarkdownRenderer}
                idBase={idBase}
              />
            </div>
            {!feedback ? (
              <Button
                type="button"
                onClick={() => void submitAnswer(structuredValue)}
                disabled={
                  !structuredAnswerReady(shape.type, structuredValue) || pending
                }
                data-quiz-check=""
                className="mt-3 h-11 px-4 sm:h-9"
              >
                Check answer
                <kbd
                  aria-hidden="true"
                  className="ml-1 hidden rounded border border-current/25 px-1 font-sans text-[11px] leading-4 font-normal opacity-70 pointer-fine:inline"
                >
                  Enter
                </kbd>
              </Button>
            ) : null}
          </>
        ) : recall ? (
          <div className="mt-1" aria-live="polite">
            {recall.step === "thinking" || recall.step === "revealing" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Answer it in your head first, then check.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void reveal()}
                    disabled={recall.step === "revealing"}
                    className="h-11 rounded-xl"
                  >
                    Show answer
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setRecall(null)}
                    disabled={recall.step === "revealing"}
                    className="h-11 rounded-xl text-muted-foreground"
                  >
                    Show options
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="mt-2 rounded-xl border border-emerald-500/45 bg-emerald-500/[0.06] px-3 py-2.5 text-sm text-foreground">
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    Answer
                  </p>
                  <div className="mt-1">
                    {plainMarkdownRenderer(recall.reveal.answer, { inline: true })}
                  </div>
                </div>
                {recall.reveal.body ? (
                  <div className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {plainMarkdownRenderer(recall.reveal.body)}
                  </div>
                ) : null}
                {recall.step === "revealed" ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void grade(true)}
                      disabled={pending}
                      className="h-11 rounded-xl"
                    >
                      I knew it
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void grade(false)}
                      disabled={pending}
                      className="h-11 rounded-xl"
                    >
                      I didn&apos;t
                    </Button>
                  </div>
                ) : (
                  <p
                    className={cn(
                      "mt-3 text-sm font-medium",
                      recall.knewIt
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-muted-foreground"
                    )}
                  >
                    {recall.knewIt ? "Nice recall." : "It will come back sooner."}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {isMultipleAnswer ? "Select all that apply" : "Choose one"}
              </p>
              {!feedback ? (
                <GuessToggle pressed={guessing} onPressedChange={setGuessing} />
              ) : null}
            </div>
            <div
              className="mt-3 grid gap-2"
              role={isMultipleAnswer ? "group" : "radiogroup"}
              aria-label={
                isMultipleAnswer ? "Select all that apply" : "Answer options"
              }
              aria-busy={pending}
            >
              {optionsForCard().map((option, optionIndex) => {
                const isSelected = isMultipleAnswer
                  ? selectedMany.includes(option.id)
                  : selected === option.id
                const optionRole = isMultipleAnswer ? "checkbox" : "radio"
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-quiz-option=""
                    role={optionRole}
                    aria-checked={isSelected}
                    disabled={pending || feedback !== null}
                    onClick={() => {
                      if (isMultipleAnswer) {
                        toggleChoice(option.id)
                      } else {
                        selectChoice(option.id)
                      }
                    }}
                    aria-label={optionAriaLabel(
                      option.text,
                      isSelected,
                      feedback !== null,
                      optionIsCorrect(option.id)
                    )}
                    className={optionClass(option.id, isSelected)}
                  >
                    {card.type !== "true-false" ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground",
                          isSelected && !feedback && "border-brand/60 text-brand"
                        )}
                      >
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 break-words">
                      {plainMarkdownRenderer(option.text, { inline: true })}
                    </span>
                    {feedback && (optionIsCorrect(option.id) || isSelected) ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "ml-auto flex shrink-0 items-center gap-1 text-xs font-medium",
                          optionIsCorrect(option.id)
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-destructive"
                        )}
                      >
                        {optionIsCorrect(option.id) ? (
                          <CheckCircleIcon size={15} />
                        ) : (
                          <CancelIcon size={15} />
                        )}
                        {optionIsCorrect(option.id)
                          ? isSelected
                            ? "Your answer, correct"
                            : "Correct answer"
                          : "Your answer"}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
            {isMultipleAnswer && !feedback ? (
              <Button
                type="button"
                onClick={submitMultiple}
                disabled={!selectedMany.length || pending || feedback !== null}
                data-quiz-check=""
                className="mt-3 h-11 px-4 sm:h-9"
              >
                Check answers
                <kbd
                  aria-hidden="true"
                  className="ml-1 hidden rounded border border-current/25 px-1 font-sans text-[11px] leading-4 font-normal opacity-70 pointer-fine:inline"
                >
                  Enter
                </kbd>
              </Button>
            ) : null}
          </>
        )}

        {feedback && feedback.status !== "invalid" ? (
          <div className="mt-3 space-y-2" aria-live="polite">
            <p
              className={cn(
                "flex items-center gap-2 text-sm font-medium",
                feedback.isCorrect
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-destructive"
              )}
            >
              {feedback.isCorrect ? (
                <CheckCircleIcon size={16} aria-hidden="true" />
              ) : (
                <CancelIcon size={16} aria-hidden="true" />
              )}
              {feedback.isCorrect ? "Correct" : "Not quite"}
            </p>
            {feedback.feedback?.body ? (
              <div className="text-sm leading-relaxed">
                {plainMarkdownRenderer(feedback.feedback.body)}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {handled || card.type === "explain" ? (
          <Button
            type="button"
            onClick={() => onNext(card)}
            className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
          >
            {card.type === "explain" ? "Got it" : "Next"}
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={() => onAsk(card)}
          className="min-h-11 rounded-full px-4"
        >
          <ChatIcon aria-hidden="true" /> Ask in chat
        </Button>
        {!handled && card.type !== "explain" ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNext(card)}
            className="ml-auto min-h-11 rounded-full px-4 text-muted-foreground"
          >
            Skip
          </Button>
        ) : null}
      </div>
    </article>
  )
}

/** Gives screen readers the same correctness state shown by option colors. */
function optionAriaLabel(
  text: string,
  selected: boolean,
  feedbackShown: boolean,
  correct: boolean
): string {
  if (!feedbackShown) return text
  if (correct) return `${text}, correct answer`
  if (selected) return `${text}, your answer was incorrect`
  return text
}
