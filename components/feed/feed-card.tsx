"use client"

/** Renders one server-backed card and owns its answer selection and feedback state. */

import { useState } from "react"

import type {
  AnswerResponse,
  FeedCard,
  FeedOption,
  LearningAnswer,
} from "@/lib/learning/client-contracts"
import { Button } from "@/components/ui/button"
import { CancelIcon, CheckIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

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
      "flex min-h-14 w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.045] px-4 text-left text-sm text-white/80 transition-[background-color,border-color,transform] duration-200 hover:border-white/22 hover:bg-white/[0.075] focus-visible:ring-2 focus-visible:ring-[#ff8065] focus-visible:outline-none active:scale-[0.99] disabled:cursor-default sm:px-5 sm:text-base",
      isSelected &&
        !showFeedback &&
        "border-[#ff8065]/65 bg-[#ff8065]/10 text-white",
      showFeedback &&
        optionIsCorrect(optionId) &&
        "border-emerald-400/65 bg-emerald-400/10 text-emerald-100",
      showFeedback &&
        isSelected &&
        !optionIsCorrect(optionId) &&
        "border-red-300/60 bg-red-300/10 text-red-100"
    )
  }

  return (
    <article className="flex h-svh snap-start items-center px-4 pt-24 pb-10 sm:px-8 sm:pt-20 sm:pb-8">
      <div className="mx-auto flex max-h-full min-h-0 w-full max-w-[680px] [scrollbar-width:none] flex-col overflow-y-auto [&::-webkit-scrollbar]:hidden">
        <h2 className="max-w-[620px] text-[clamp(2rem,7vw,3.75rem)] leading-[0.99] font-medium tracking-[-0.045em] text-white sm:text-[clamp(2rem,5vw,2.5rem)]">
          {card.type === "explain" ? card.title : card.question}
        </h2>

        {card.type === "explain" ? (
          <p className="mt-7 max-w-[590px] text-base leading-[1.65] text-white/62 sm:mt-5 sm:text-lg">
            {card.body}
          </p>
        ) : (
          <>
            {isMultipleAnswer ? (
              <p className="mt-5 text-sm text-white/60">
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
                        "flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/12 text-xs font-medium text-white/52",
                        isSelected &&
                          !feedback &&
                          "border-[#ff8065]/60 bg-[#ff8065]/15 text-[#ffb19e]",
                        feedback &&
                          optionIsCorrect(option.id) &&
                          "border-emerald-300/50 bg-emerald-300/12 text-emerald-100",
                        feedback &&
                          isSelected &&
                          !optionIsCorrect(option.id) &&
                          "border-red-200/45 bg-red-200/10 text-red-100"
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
                    <span className="flex-1">{option.text}</span>
                  </button>
                )
              })}
            </div>
            {isMultipleAnswer && !feedback ? (
              <Button
                type="button"
                onClick={submitMultiple}
                disabled={!selectedMany.length || pending || feedback !== null}
                className="mt-5 h-11 rounded-[20px] bg-[#ff8065] px-5 text-sm font-medium text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
              >
                Check answers
              </Button>
            ) : null}
          </>
        )}

        <p className="mt-7 text-xs text-white/45 sm:mt-5">
          Source · {card.sourceLabel}
        </p>

        {feedback && feedback.status !== "invalid" ? (
          <div className="mt-5 space-y-1.5" aria-live="polite">
            <p
              className={cn(
                "text-sm font-medium",
                feedback.isCorrect ? "text-emerald-300" : "text-red-300"
              )}
            >
              {feedback.isCorrect ? "Correct" : "Not quite"}
            </p>
            {feedback.feedback?.body ? (
              <p className="text-sm leading-relaxed text-white/52">
                {feedback.feedback.body}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-5 text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => onAsk(card)}
            className="h-11 rounded-[20px] border-white/12 bg-transparent px-5 text-sm text-white/72 hover:border-white/25 hover:bg-white/[0.07] hover:text-white"
          >
            Ask in chat
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSkip(card)}
            className="h-11 rounded-[20px] px-4 text-sm text-white/48 hover:bg-white/[0.06] hover:text-white"
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
