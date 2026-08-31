"use client"

import { useState } from "react"
import {
  ArrowDown,
  Check,
  CheckCircle2,
  HelpCircle,
  Link2,
  Lightbulb,
  RotateCcw,
  Sparkles,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type StudyCardData = {
  _id: string
  type: "explain" | "recall" | "multiple_choice" | "connection"
  title: string
  body?: string
  question?: string
  answer?: string
  options?: string[]
  correctOption?: number
  sourceLabel?: string
}

const cardMeta = {
  explain: {
    label: "Explain",
    icon: Lightbulb,
    tint: "bg-[#fff7c2] text-[#8a6800] dark:bg-yellow-400/15 dark:text-yellow-300",
  },
  recall: {
    label: "Recall",
    icon: HelpCircle,
    tint: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  },
  multiple_choice: {
    label: "Quiz",
    icon: CheckCircle2,
    tint: "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  },
  connection: {
    label: "Connect",
    icon: Link2,
    tint: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
} as const

type StudyCardProps = {
  card: StudyCardData
  index: number
  onRate: (rating: "again" | "got_it") => void
}

export function StudyCard({ card, index, onRate }: StudyCardProps) {
  const [revealed, setRevealed] = useState(
    card.type === "explain" || card.type === "connection"
  )
  const [selected, setSelected] = useState<number | null>(null)
  const meta = cardMeta[card.type]
  const Icon = meta.icon
  const hasAnswer = Boolean(card.answer)
  const isCorrect = selected !== null && selected === card.correctOption

  return (
    <article className="relative flex min-h-full snap-start snap-always items-center px-4 py-14 sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-3xl flex-col">
        <div className="mb-8 flex items-center justify-between gap-4 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          <span>Card {String(index + 1).padStart(2, "0")}</span>
          {card.sourceLabel ? (
            <span className="max-w-[55%] truncate text-right tracking-normal normal-case">
              {card.sourceLabel}
            </span>
          ) : null}
        </div>

        <div className="mb-8 flex items-center gap-3">
          <div
            className={cn(
              "flex size-14 items-center justify-center rounded-2xl",
              meta.tint
            )}
          >
            <Icon aria-hidden="true" className="size-8" strokeWidth={2.2} />
          </div>
          <Badge
            className={cn("rounded-full px-3 py-1", meta.tint)}
            variant="ghost"
          >
            {meta.label}
          </Badge>
        </div>

        <h2 className="max-w-2xl text-4xl leading-[1.03] font-semibold tracking-[-0.045em] sm:text-6xl">
          {card.title}
        </h2>

        {card.type === "multiple_choice" ? (
          <div
            className="mt-10 space-y-3"
            role="radiogroup"
            aria-label="Answer options"
          >
            {(card.options ?? []).map((option, optionIndex) => {
              const answered = selected !== null
              const correct = optionIndex === card.correctOption
              return (
                <button
                  key={`${option}-${optionIndex}`}
                  type="button"
                  role="radio"
                  aria-checked={selected === optionIndex}
                  onClick={() => setSelected(optionIndex)}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-4 rounded-2xl border border-border/80 bg-card/70 px-5 text-left text-base transition-colors focus-visible:ring-4 focus-visible:ring-primary/30 focus-visible:outline-none",
                    answered &&
                      correct &&
                      "border-emerald-500 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                    answered &&
                      selected === optionIndex &&
                      !correct &&
                      "border-red-400 bg-red-400/10 text-red-800 dark:text-red-200"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                    {String.fromCharCode(65 + optionIndex)}
                  </span>
                  <span className="flex-1">{option}</span>
                  {answered && correct ? (
                    <Check aria-hidden="true" className="size-5" />
                  ) : null}
                </button>
              )
            })}
            {selected !== null ? (
              <div className="pt-2">
                <p
                  className={cn(
                    "text-sm font-medium",
                    isCorrect
                      ? "text-emerald-600 dark:text-emerald-300"
                      : "text-red-600 dark:text-red-300"
                  )}
                >
                  {isCorrect
                    ? "Correct — nice work."
                    : "Not quite. The highlighted answer is correct."}
                </p>
                {card.answer ? (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {card.answer}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-10 max-w-2xl">
            {card.type === "recall" && card.question ? (
              <p className="text-xl leading-relaxed font-medium sm:text-2xl">
                {card.question}
              </p>
            ) : null}
            {card.body ? (
              <p className="mt-5 text-lg leading-relaxed text-muted-foreground sm:text-xl">
                {card.body}
              </p>
            ) : null}
            {hasAnswer ? (
              <div
                className={cn(
                  "mt-8 overflow-hidden rounded-2xl border border-dashed border-border transition-colors",
                  revealed ? "bg-primary/10" : "bg-muted/40"
                )}
              >
                {revealed ? (
                  <p className="p-5 text-lg leading-relaxed sm:text-xl">
                    {card.answer}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className="flex min-h-24 w-full items-center justify-center gap-3 p-5 text-base font-semibold hover:bg-muted/60 focus-visible:ring-4 focus-visible:ring-primary/30 focus-visible:outline-none"
                  >
                    <Sparkles
                      aria-hidden="true"
                      className="size-5 text-primary"
                    />{" "}
                    Tap to reveal answer
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}

        <div className="mt-12 flex flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-12 rounded-full px-5"
            onClick={() => onRate("again")}
          >
            <RotateCcw aria-hidden="true" /> Again
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-12 rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/85"
            onClick={() => onRate("got_it")}
            disabled={
              (card.type === "recall" && hasAnswer && !revealed) ||
              (card.type === "multiple_choice" && selected === null)
            }
          >
            <Check aria-hidden="true" /> Got it
          </Button>
        </div>
      </div>
      <ArrowDown
        aria-hidden="true"
        className="absolute bottom-7 left-1/2 size-5 -translate-x-1/2 animate-bounce text-muted-foreground motion-reduce:animate-none"
      />
    </article>
  )
}
