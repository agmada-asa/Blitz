"use client"

/** Renders one server-backed card and owns its answer selection and feedback state. */

import { useId, useState } from "react"

import type {
  AnswerResponse,
  FeedCard,
  FeedOption,
  LearningAnswer,
} from "@/lib/learning/client-contracts"
import { Button } from "@/components/ui/button"
import { CancelIcon, CheckIcon } from "@/components/ui/icon"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
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

/** Props required to render one card in the home feed. */
type FeedCardProps = {
  card: FeedCard
  onAsk: (card: FeedCard) => void
  onSkip: (card: FeedCard) => void
  onAnswer: (card: FeedCard, answer: LearningAnswer) => Promise<AnswerResponse>
}

/** Renders a server-backed explanation or question card. */
export function FeedCardView({ card, onAsk, onSkip, onAnswer }: FeedCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedMany, setSelectedMany] = useState<string[]>([])
  const [feedback, setFeedback] = useState<AnswerResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
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
      const result = await onAnswer(card, answer)
      if (result.status === "invalid") {
        setError("That answer could not be checked. Try again.")
        setFeedback(null)
      } else {
        setFeedback(result)
      }
    } catch {
      setError("Could not check that answer. Try again.")
      setFeedback(null)
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
        "border-destructive/60 bg-destructive/10 text-destructive dark:border-red-400/60 dark:bg-red-400/15 dark:text-red-100"
    )
  }

  return (
    <article className="feed-card flex h-svh snap-start items-center px-4 pt-24 pb-10 sm:px-8 sm:pt-20 sm:pb-8">
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
            <p className="mt-5 text-sm text-muted-foreground">
              {structuredHints[shape.type as keyof typeof structuredHints]}
            </p>
            <div className="mt-4" aria-busy={pending}>
              <StructuredAnswer
                shape={shape}
                value={structuredValue}
                onChange={setStructuredValue}
                disabled={pending || feedback !== null}
                answerKey={feedback?.feedback}
                correct={feedback ? feedback.isCorrect : undefined}
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
                className="mt-5 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85 focus-visible:ring-ring"
              >
                Check answer
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {isMultipleAnswer ? (
              <p className="mt-5 text-sm text-muted-foreground">
                Select all that apply
              </p>
            ) : null}
            <div
              className="mt-6 space-y-2.5 sm:mt-5"
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
                className="mt-5 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85 focus-visible:ring-ring"
              >
                Check answers
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
            {feedback ? "Next" : "Skip"}
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
