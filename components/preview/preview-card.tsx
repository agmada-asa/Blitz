"use client"

/** Renders one interactive local fixture card inside the full-screen preview feed. */

import { useState } from "react"

import type { PreviewCardData } from "@/components/preview/preview-data"
import { Button } from "@/components/ui/button"
import {
  BulbLineIcon,
  CheckCircleIcon,
  CheckIcon,
  HelpIcon,
  SparklesIcon,
} from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Props needed to render and navigate one fixture card. */
type PreviewCardProps = {
  card: PreviewCardData
  index: number
  total: number
  onAsk: (card: PreviewCardData) => void
  onSkip: (index: number) => void
}

/** Returns the icon associated with a preview card format. */
function CardIcon({ type }: { type: PreviewCardData["type"] }) {
  if (type === "explain") {
    return <BulbLineIcon aria-hidden="true" className="size-5" />
  }
  if (type === "single_choice") {
    return <HelpIcon aria-hidden="true" className="size-5" />
  }
  return <CheckCircleIcon aria-hidden="true" className="size-5" />
}

/** Presents explanation, single-choice, and multiple-answer interactions. */
export function PreviewCard({
  card,
  index,
  total,
  onAsk,
  onSkip,
}: PreviewCardProps) {
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedMany, setSelectedMany] = useState<number[]>([])
  const [submitted, setSubmitted] = useState(false)
  const isSingleChoice = card.type === "single_choice"
  const isMultipleAnswer = card.type === "multiple_answer"
  const isSingleCorrect = selected === card.correctOption
  const correctMany = card.correctOptions ?? []
  const isManyCorrect =
    submitted &&
    selectedMany.length === correctMany.length &&
    selectedMany.every((choice) => correctMany.includes(choice))

  /** Selects a single answer and immediately reveals its feedback. */
  function selectSingle(optionIndex: number) {
    setSelected(optionIndex)
  }

  /** Toggles one multiple-answer option until the user submits the set. */
  function toggleMany(optionIndex: number) {
    setSubmitted(false)
    setSelectedMany((current) =>
      current.includes(optionIndex)
        ? current.filter((choice) => choice !== optionIndex)
        : [...current, optionIndex]
    )
  }

  /** Submits the selected multiple-answer options for local feedback. */
  function submitMany() {
    setSubmitted(true)
  }

  return (
    <article className="flex h-svh snap-start items-center px-4 pt-28 pb-10 sm:px-8 sm:pt-24 sm:pb-8">
      <div className="mx-auto flex max-h-full min-h-0 w-full max-w-[680px] [scrollbar-width:none] flex-col overflow-y-auto [&::-webkit-scrollbar]:hidden">
        <div className="mb-7 flex items-center justify-between gap-4 text-[11px] font-medium tracking-[0.16em] text-white/55 uppercase sm:mb-5">
          <span>{card.eyebrow}</span>
          <span className="shrink-0 tabular-nums">
            {String(index + 1).padStart(2, "0")} /{" "}
            {String(total).padStart(2, "0")}
          </span>
        </div>

        <div className="mb-7 flex items-center gap-3 text-sm text-[#ff8065] sm:mb-5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-[#ff8065]/12 ring-1 ring-[#ff8065]/18">
            <CardIcon type={card.type} />
          </span>
          <span className="font-medium">{card.label}</span>
          <span className="ml-auto text-xs text-white/55">
            {card.sourceLabel}
          </span>
        </div>

        <h2 className="max-w-[620px] text-[clamp(2rem,7vw,3.75rem)] leading-[0.99] font-medium tracking-[-0.045em] text-white sm:text-[clamp(2rem,5vw,2.5rem)]">
          {card.title}
        </h2>

        {card.body ? (
          <p className="mt-7 max-w-[590px] text-base leading-[1.65] text-white/62 sm:mt-5 sm:text-lg">
            {card.body}
          </p>
        ) : null}

        {card.question ? (
          <p className="mt-8 text-sm leading-relaxed text-white/48 sm:mt-6">
            {card.question}
          </p>
        ) : null}

        {isSingleChoice || isMultipleAnswer ? (
          <div
            className="mt-6 space-y-2.5 sm:mt-5"
            role={isSingleChoice ? "radiogroup" : "group"}
            aria-label={`${card.label} answers`}
          >
            {(card.options ?? []).map((option, optionIndex) => {
              const isSelected = isSingleChoice
                ? selected === optionIndex
                : selectedMany.includes(optionIndex)
              const isCorrect = isSingleChoice
                ? optionIndex === card.correctOption
                : correctMany.includes(optionIndex)
              const showFeedback = isSingleChoice
                ? selected !== null
                : submitted

              return (
                <button
                  key={option}
                  type="button"
                  role={isSingleChoice ? "radio" : "checkbox"}
                  aria-checked={isSelected}
                  onClick={() =>
                    isSingleChoice
                      ? selectSingle(optionIndex)
                      : toggleMany(optionIndex)
                  }
                  className={cn(
                    "flex min-h-14 w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.045] px-4 text-left text-sm text-white/80 transition-[background-color,border-color,transform] duration-200 hover:border-white/22 hover:bg-white/[0.075] focus-visible:ring-2 focus-visible:ring-[#ff8065] focus-visible:outline-none active:scale-[0.99] sm:px-5 sm:text-base",
                    isSelected &&
                      !showFeedback &&
                      "border-[#ff8065]/65 bg-[#ff8065]/10 text-white",
                    showFeedback &&
                      isCorrect &&
                      "border-emerald-400/65 bg-emerald-400/10 text-emerald-100",
                    showFeedback &&
                      isSelected &&
                      !isCorrect &&
                      "border-red-300/60 bg-red-300/10 text-red-100"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/12 text-xs font-medium text-white/52",
                      isSelected &&
                        !showFeedback &&
                        "border-[#ff8065]/60 bg-[#ff8065]/15 text-[#ffb19e]",
                      showFeedback &&
                        isCorrect &&
                        "border-emerald-300/50 bg-emerald-300/12 text-emerald-100",
                      showFeedback &&
                        isSelected &&
                        !isCorrect &&
                        "border-red-200/45 bg-red-200/10 text-red-100"
                    )}
                  >
                    {showFeedback && isCorrect ? (
                      <CheckIcon aria-hidden="true" className="size-4" />
                    ) : (
                      String.fromCharCode(65 + optionIndex)
                    )}
                  </span>
                  <span className="flex-1">{option}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {isSingleChoice && selected !== null ? (
          <FeedbackMessage correct={isSingleCorrect} answer={card.answer} />
        ) : null}

        {isMultipleAnswer && submitted ? (
          <FeedbackMessage correct={isManyCorrect} answer={card.answer} />
        ) : null}

        {card.answer && card.type === "explain" ? (
          <div className="mt-7 rounded-2xl border border-white/10 bg-[#151515] p-5 text-sm leading-relaxed text-white/66 sm:mt-5 sm:p-6 sm:text-base">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.12em] text-[#ff9b86] uppercase">
              <SparklesIcon aria-hidden="true" className="size-4" />
              Key idea
            </div>
            {card.answer}
          </div>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-6">
          {isMultipleAnswer ? (
            <Button
              type="button"
              onClick={submitMany}
              disabled={selectedMany.length === 0}
              className="h-11 rounded-[20px] bg-[#ff8065] px-5 text-sm font-medium text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
            >
              Check answers
            </Button>
          ) : null}
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
            onClick={() => onSkip(index)}
            className="h-11 rounded-[20px] px-4 text-sm text-white/48 hover:bg-white/[0.06] hover:text-white"
          >
            Skip <span aria-hidden="true">↵</span>
          </Button>
        </div>
      </div>
    </article>
  )
}

/** Announces immediate answer feedback and the fixture's short explanation. */
function FeedbackMessage({
  correct,
  answer,
}: {
  correct: boolean
  answer?: string
}) {
  return (
    <div className="mt-5 space-y-1.5" aria-live="polite">
      <p
        className={cn(
          "text-sm font-medium",
          correct ? "text-emerald-300" : "text-red-300"
        )}
      >
        {correct
          ? "Correct. Nice read."
          : "Not quite. Try the highlighted answer."}
      </p>
      {answer ? (
        <p className="text-sm leading-relaxed text-white/52">{answer}</p>
      ) : null}
    </div>
  )
}
