"use client"

/**
 * Renders one server-backed card and owns its answer selection and feedback state. Number keys,
 * letters, and Enter answer the card or move on once it is answered (see `hooks/use-quiz-shortcuts.ts`).
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
import { CancelIcon, CheckIcon } from "@/components/ui/icon"
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

/** Headline sizes: short prompts read as a headline, long exam questions as body text. */
function headlineClass(text: string): string {
  if (text.length > 180 || text.includes("```"))
    return "text-xl leading-snug font-medium tracking-tight sm:text-2xl"
  if (text.length > 90)
    return "text-[clamp(1.5rem,5vw,2rem)] leading-tight font-medium tracking-[-0.03em]"
  return "text-[clamp(2rem,7vw,3.75rem)] leading-[0.99] font-medium tracking-[-0.045em] sm:text-[clamp(2rem,5vw,2.5rem)]"
}

/** Props required to render one card in the Review feed. */
type FeedCardProps = {
  card: FeedCard
  onAsk: (card: FeedCard) => void
  onSkip: (card: FeedCard) => void
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
  onAsk,
  onSkip,
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
      feedback || recall?.step === "graded" ? () => onSkip(card) : undefined,
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
    return cn(
      "flex min-h-14 w-full items-center gap-4 rounded-2xl border border-border/80 bg-card/60 px-4 text-left text-sm text-foreground/90 transition-[background-color,border-color,transform] duration-200 hover:border-foreground/20 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.99] disabled:cursor-default sm:px-5 sm:text-base",
      isSelected &&
        !showFeedback &&
        "border-brand bg-brand/10 font-medium text-foreground",
      showFeedback &&
        optionIsCorrect(optionId) &&
        "border-emerald-500/60 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/65 dark:bg-emerald-400/15 dark:text-emerald-100",
      showFeedback &&
        isSelected &&
        !optionIsCorrect(optionId) &&
        "border-destructive/60 bg-destructive/10 text-destructive dark:border-red-400/60 dark:bg-red-400/15 dark:text-red-100",
      showFeedback && isSelected && answerCueClass(cue)
    )
  }

  return (
    <article
      ref={cardRef}
      data-quiz-scope=""
      className="feed-card flex h-svh snap-start items-center px-4 pt-24 pb-10 sm:px-8 sm:pt-20 sm:pb-8"
    >
      <div className="feed-card-content mx-auto flex max-h-full min-h-0 w-full max-w-[680px] [scrollbar-width:none] flex-col overflow-y-auto [&::-webkit-scrollbar]:hidden">
        {card.type === "explain" ? (
          <p className="mb-3 text-xs font-medium text-brand">Recap</p>
        ) : null}
        {/* Questions may hold code blocks, so long ones render as Markdown blocks. */}
        {card.type !== "explain" && prompt.includes("```") ? (
          <div
            className={cn(
              "max-w-[620px] text-foreground",
              headlineClass(prompt)
            )}
          >
            {plainMarkdownRenderer(prompt)}
          </div>
        ) : (
          <h2
            className={cn(
              "max-w-[620px] text-foreground",
              headlineClass(prompt)
            )}
          >
            {plainMarkdownRenderer(prompt, { inline: true })}
          </h2>
        )}

        {card.type === "explain" ? (
          <div className="mt-6 max-w-[590px] text-base leading-[1.65] text-muted-foreground sm:mt-5 sm:text-lg">
            {plainMarkdownRenderer(card.body)}
          </div>
        ) : shape ? (
          <>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {structuredHints[shape.type as keyof typeof structuredHints]}
              </p>
              {!feedback ? (
                <GuessToggle pressed={guessing} onPressedChange={setGuessing} />
              ) : null}
            </div>
            <div className="mt-4" aria-busy={pending}>
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
                className="mt-5 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85 focus-visible:ring-ring"
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
          <div className="mt-6 sm:mt-5" aria-live="polite">
            {recall.step === "thinking" || recall.step === "revealing" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Answer it in your head first, then check.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => void reveal()}
                    disabled={recall.step === "revealing"}
                    className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
                  >
                    Show answer
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRecall(null)}
                    disabled={recall.step === "revealing"}
                    className="h-11 rounded-full px-5 text-sm"
                  >
                    Show options
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-base text-foreground sm:px-5">
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
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => void grade(true)}
                      disabled={pending}
                      className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
                    >
                      I knew it
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void grade(false)}
                      disabled={pending}
                      className="h-11 rounded-full px-5 text-sm"
                    >
                      I didn&apos;t
                    </Button>
                  </div>
                ) : (
                  <p
                    className={cn(
                      "mt-4 text-sm font-medium",
                      recall.knewIt
                        ? "text-emerald-600 dark:text-emerald-400"
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
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {isMultipleAnswer ? "Select all that apply" : "Choose one"}
              </p>
              {!feedback ? (
                <GuessToggle pressed={guessing} onPressedChange={setGuessing} />
              ) : null}
            </div>
            <div
              className="mt-4 space-y-2.5"
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
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/60 text-xs font-medium text-muted-foreground",
                        isSelected &&
                          !feedback &&
                          "border-brand/60 bg-brand/15 text-brand",
                        feedback &&
                          optionIsCorrect(option.id) &&
                          "border-emerald-500/60 bg-emerald-500/20 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-400/20 dark:text-emerald-200",
                        feedback &&
                          isSelected &&
                          !optionIsCorrect(option.id) &&
                          "border-destructive/60 bg-destructive/20 text-destructive dark:border-red-400/50 dark:bg-red-400/20 dark:text-red-200"
                      )}
                    >
                      {feedback && optionIsCorrect(option.id) ? (
                        <CheckIcon aria-hidden="true" className="size-4" />
                      ) : feedback && isSelected ? (
                        <CancelIcon aria-hidden="true" className="size-4" />
                      ) : card.type === "true-false" ? (
                        option.text.slice(0, 1)
                      ) : (
                        String.fromCharCode(65 + optionIndex)
                      )}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {plainMarkdownRenderer(option.text, { inline: true })}
                    </span>
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
                className="mt-5 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85 focus-visible:ring-ring"
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

        <p className="mt-7 text-xs text-muted-foreground sm:mt-5">
          Source · {card.sourceLabel}
        </p>

        {feedback && feedback.status !== "invalid" ? (
          <div className="mt-5 space-y-1.5" aria-live="polite">
            <p
              className={cn(
                "text-sm font-medium",
                feedback.isCorrect
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive dark:text-red-400"
              )}
            >
              {feedback.isCorrect ? "Correct" : "Not quite"}
            </p>
            {feedback.feedback?.body ? (
              <div className="text-sm leading-relaxed text-muted-foreground">
                {plainMarkdownRenderer(feedback.feedback.body)}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-5 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => onAsk(card)}
            className="h-11 rounded-full px-5 text-sm shadow-xs"
          >
            Ask in chat
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSkip(card)}
            className="h-11 rounded-full px-4 text-sm text-muted-foreground hover:text-foreground"
          >
            {feedback || recall?.step === "graded" ? "Next" : "Skip"}
          </Button>
        </div>
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
