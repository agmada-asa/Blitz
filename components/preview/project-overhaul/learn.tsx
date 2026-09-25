/** Provides compact, static Learn screens for reviewing the project redesign. */

import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  FileIcon,
} from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/** Labels the five Learn screens shown by the preview navigator. */
export const learnScenes = [
  { id: "learn-path", label: "Learning path" },
  { id: "lesson", label: "Lesson" },
  { id: "lesson-detail", label: "More detail" },
  { id: "quick-check", label: "Quick check" },
  { id: "check-feedback", label: "Check feedback" },
] as const

/** Renders one hardcoded Learn screen without project data or live actions. */
export function LearnMockup({ scene }: { scene: string }) {
  if (scene === "learn-path") return <LearningPath />
  if (scene === "lesson-detail") return <LessonDetail />
  if (scene === "quick-check") return <QuickCheck />
  if (scene === "check-feedback") return <CheckFeedback />
  return <Lesson />
}

/** Shows a short concept list with one clear resume action. */
function LearningPath() {
  const concepts = [
    "What makes a model a language model?",
    "How next-token prediction works",
    "Training data and parameters",
    "Where language models struggle",
  ]

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
        Learn
      </h1>
      <ol className="mt-6 divide-y divide-border/60 border-y border-border/60">
        {concepts.map((concept, index) => {
          const current = index === 1
          const complete = index === 0
          return (
            <li key={concept}>
              <div
                aria-current={current ? "step" : undefined}
                className={`flex min-h-14 items-center gap-3 py-3 ${current ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs ${complete ? "border-emerald-500/40 text-emerald-600" : current ? "border-brand/40 text-brand" : "border-border"}`}
                >
                  {complete ? (
                    <CheckCircleIcon aria-hidden="true" size={16} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="leading-5 font-medium">{concept}</span>
              </div>
            </li>
          )
        })}
      </ol>
      <Button className="mt-6 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85">
        Resume learning <ArrowRightIcon aria-hidden="true" />
      </Button>
    </main>
  )
}

/** Shows one focused concept, compact example, source, and next action. */
function Lesson() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="max-w-2xl font-heading text-[clamp(2rem,6vw,4rem)] leading-[1.02] font-medium tracking-[-0.04em]">
        A language model predicts one token at a time
      </h1>
      <p className="mt-5 max-w-[64ch] text-base leading-7 text-foreground/80 sm:text-lg">
        At each step, it estimates what token is most likely to follow the text
        so far, then repeats that process to build a response.
      </p>
      <div className="mt-6 rounded-xl bg-card px-4 py-4 ring-1 ring-foreground/10 sm:px-5">
        <p className="font-heading text-lg leading-7 sm:text-xl">
          The capital of France is <span className="text-brand">Paris</span>
        </p>
      </div>
      <SourceReference />
      <Button className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85">
        Quick check <ArrowRightIcon aria-hidden="true" />
      </Button>
    </main>
  )
}

/** Shows a concise deeper explanation and the supporting source excerpt. */
function LessonDetail() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
        Why next-token prediction matters
      </h1>
      <p className="mt-5 max-w-[64ch] text-base leading-7 text-foreground/80">
        The model does not plan a whole answer before it starts. It predicts a
        likely continuation, adds it to the context, then predicts again. This
        makes fluent text possible, but a plausible continuation can still be
        wrong.
      </p>
      <blockquote className="mt-6 border-l-2 border-brand/60 pl-4 text-sm leading-6 text-muted-foreground">
        “The next token is conditioned on the preceding tokens.”
      </blockquote>
      <SourceReference />
      <Button className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85">
        Quick check <ArrowRightIcon aria-hidden="true" />
      </Button>
    </main>
  )
}

/** Presents a short question and its answer options. */
function QuickCheck() {
  const choices = [
    "The next token, given the context so far",
    "A complete paragraph before writing",
    "A word from a fixed dictionary",
  ]

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
        What does a language model predict at each step?
      </h1>
      <div className="mt-6 space-y-2" aria-label="Answer options">
        {choices.map((choice, index) => (
          <div
            key={choice}
            className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 py-3 text-sm sm:px-4 sm:text-base ${index === 0 ? "border-brand/40 bg-brand/[0.05]" : "border-border/70 bg-card"}`}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">
              {String.fromCharCode(65 + index)}
            </span>
            <span className="leading-5">{choice}</span>
          </div>
        ))}
      </div>
      <Button className="mt-6 min-h-11 rounded-full bg-brand px-5 text-brand-foreground">
        Check answer
      </Button>
    </main>
  )
}

/** Shows concise feedback, source attribution, and one next action. */
function CheckFeedback() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
        What does a language model predict at each step?
      </h1>
      <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-500/35 bg-emerald-500/[0.06] px-4 py-4">
        <CheckIcon
          size={18}
          className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300"
          aria-hidden="true"
        />
        <div>
          <p className="font-medium">Correct</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            It predicts the next token from the context so far.
          </p>
        </div>
      </div>
      <SourceReference />
      <Button className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85">
        Next concept <ArrowRightIcon aria-hidden="true" />
      </Button>
    </main>
  )
}

/** Identifies the hardcoded source location used by the learning content. */
function SourceReference() {
  return (
    <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
      <FileIcon size={16} aria-hidden="true" />
      Intro_to_LLMs.pdf · page 8
    </p>
  )
}
