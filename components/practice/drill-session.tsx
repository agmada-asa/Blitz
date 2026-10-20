"use client"

/**
 * One adaptive drill: up to ten questions, missed and weak material first,
 * with immediate feedback. A wrong answer offers Relearn, which re-teaches
 * the concept in the unit's Teach session. The end screen summarises the
 * drill: XP, concepts and their strength, today's goal, and what to relearn. The deck is fetched once so
 * answering does not reshuffle it mid-drill.
 */

import Link from "next/link"
import { useConvex } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { relearnLink } from "@/components/practice/practice-hub"
import { SessionSummary } from "@/components/progress/session-summary"
import { Button } from "@/components/ui/button"
import { InteractiveBlocksProvider } from "@/components/ui/interactive-blocks"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
import { QuizBlockView } from "@/components/ui/interactive-blocks/quiz-block"
import { ArrowLeftIcon, ArrowRightIcon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { createClientMessageId } from "@/lib/client/teach-turn"
import type { QuizBlock } from "@/lib/interactive-blocks"
import { COMBO_START, comboBonus } from "@/lib/progress"

/** One question in the drill deck. */
type DrillQuestion = FunctionReturnType<typeof api.practice.drill>[number]

/** Questions asked in one drill. */
const DRILL_LENGTH = 10

/** Result of one answered question. */
type DrillResult = { correct: boolean }

/**
 * Posts an answer to the shared learning endpoint, which scores it and
 * updates the concept's review state.
 * @throws With a learner-facing message when the answer could not be saved.
 */
async function submitAnswer(
  projectId: string,
  question: DrillQuestion,
  selectedOptionIds: string[],
  confidence?: "guess"
): Promise<{ correct: boolean }> {
  const [first] = selectedOptionIds
  const answer =
    question.quiz.type === "true-false"
      ? first === "true"
      : question.quiz.type === "single-choice"
        ? first
        : selectedOptionIds
  const response = await fetch("/api/learning/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      itemId: question.itemId,
      clientEventId: `drill:${createClientMessageId()}`,
      occurredAt: Date.now(),
      answer,
      ...(confidence ? { confidence } : {}),
    }),
  })
  const payload = (await response.json().catch(() => null)) as {
    isCorrect?: unknown
    status?: unknown
    error?: unknown
  } | null
  if (!response.ok || typeof payload?.isCorrect !== "boolean" || payload.status === "invalid")
    throw new Error(typeof payload?.error === "string" ? payload.error : "Your answer could not be saved.")
  return { correct: payload.isCorrect }
}

/** Renders a drill for a module, optionally limited to one unit. */
export function DrillSession({ projectId, unitId }: { projectId: string; unitId?: string }) {
  const convex = useConvex()
  const [deck, setDeck] = useState<DrillQuestion[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [index, setIndex] = useState(0)
  const [results, setResults] = useState<Record<string, DrillResult>>({})
  const [round, setRound] = useState(0)
  // When this round's deck arrived; the summary counts answers from then on.
  const [startedAt, setStartedAt] = useState(0)
  // Right answers in a row this round, for the combo counter.
  const [run, setRun] = useState(0)
  const nextRef = useRef<HTMLButtonElement>(null)
  const base = `/projects/${encodeURIComponent(projectId)}`

  // Fetches a fresh deck at the start of each round.
  useEffect(() => {
    let active = true
    convex
      .query(api.practice.drill, {
        projectId: projectId as Id<"projects">,
        ...(unitId ? { unitId: unitId as Id<"units"> } : {}),
        limit: DRILL_LENGTH,
        now: Date.now(),
      })
      .then((questions) => {
        if (!active) return
        setLoadError("")
        setDeck(questions)
        setStartedAt(Date.now())
        setIndex(0)
        setResults({})
        setRun(0)
      })
      .catch(() => {
        if (active) setLoadError("Questions could not be loaded. Try again.")
      })
    return () => {
      active = false
    }
  }, [convex, projectId, unitId, round])

  const current = deck?.[index]
  const answered = current ? results[current.itemId] : undefined
  const finished = Boolean(deck && deck.length && index >= deck.length)

  const onQuizAnswer = useCallback(
    async (_block: QuizBlock, selectedOptionIds: string[], confidence?: "guess") => {
      if (!current) return null
      const result = await submitAnswer(projectId, current, selectedOptionIds, confidence)
      setResults((previous) => ({ ...previous, [current.itemId]: result }))
      setRun((value) => (result.correct ? value + 1 : 0))
      // Move focus to Next so keyboard learners can continue with Enter.
      window.requestAnimationFrame(() => nextRef.current?.focus())
      return result
    },
    [current, projectId]
  )
  const interactive = useMemo(
    () => ({ onQuizAnswer, acceptsConfidence: true }),
    [onQuizAnswer]
  )

  const correctCount = Object.values(results).filter((result) => result.correct).length
  const missed = deck?.filter((question) => results[question.itemId]?.correct === false) ?? []

  return (
    <main className="mx-auto flex min-h-[calc(100svh-84px)] w-full max-w-2xl flex-col px-4 py-6 text-foreground sm:px-6 sm:py-10 md:min-h-svh">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-9">
          <Link href={`${base}/practice`}>
            <ArrowLeftIcon aria-hidden="true" /> Practice
          </Link>
        </Button>
        {deck && deck.length && !finished ? (
          <p className="flex items-center gap-3 text-sm text-muted-foreground tabular-nums">
            {run >= COMBO_START ? (
              <span key={run} className="combo-chip font-medium text-brand">
                {run} in a row · +{comboBonus(run)} XP
              </span>
            ) : null}
            <span>
              {index + 1} of {deck.length}
            </span>
          </p>
        ) : null}
      </div>
      {deck && deck.length && !finished ? (
        <Progress
          value={(index / deck.length) * 100}
          aria-label={`Question ${index + 1} of ${deck.length}`}
          className="mt-3 h-1 [&_[data-slot=progress-indicator]]:bg-brand"
        />
      ) : null}

      {loadError ? (
        <div className="mt-10" role="alert">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button
            className="mt-4 min-h-11 rounded-full"
            onClick={() => {
              setLoadError("")
              setDeck(null)
              setRound((value) => value + 1)
            }}
          >
            Try again
          </Button>
        </div>
      ) : deck === null ? (
        <div className="mt-10 space-y-3" aria-label="Loading questions">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !deck.length ? (
        <section className="mt-10">
          <h1 className="font-heading text-2xl font-semibold">No questions yet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Write questions for a unit on the Practice screen, then come back to drill.
          </p>
          <Button asChild className="mt-5 min-h-11 rounded-full">
            <Link href={`${base}/practice`}>Go to Practice</Link>
          </Button>
        </section>
      ) : finished ? (
        <div className="mt-10">
          <SessionSummary
            projectId={projectId}
            unitId={unitId}
            since={startedAt}
            eyebrow="Drill complete"
            title={`${correctCount} of ${deck.length} correct`}
            headingLevel="h1"
            actions={
              <>
                <Button
                  onClick={() => {
                    setDeck(null)
                    setRound((value) => value + 1)
                  }}
                  className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
                >
                  Drill again
                </Button>
                <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
                  <Link href={`${base}/practice`}>Back to Practice</Link>
                </Button>
              </>
            }
          >
            {missed.length ? (
              <div className="mt-6">
                <h2 className="text-sm font-medium">Missed</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  These come back first next time. Relearn them now while they are fresh.
                </p>
                <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
                  {missed.map((question) => (
                    <li
                      key={question.itemId}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="font-medium break-words">{question.quiz.concept}</p>
                        <p className="text-xs text-muted-foreground">{question.unitTitle}</p>
                      </div>
                      <Button asChild variant="outline" className="min-h-10 shrink-0 rounded-full px-4">
                        <Link {...relearnLink(projectId, question.unitId, question.quiz.concept, question.quiz.question)}>
                          Relearn
                        </Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </SessionSummary>
        </div>
      ) : current ? (
        <section className="mt-8 flex-1" aria-label={`Question ${index + 1}`}>
          <p className="mb-3 text-xs text-muted-foreground">
            {current.unitTitle}
            {current.lastOutcome === "incorrect" ? " · You missed this last time" : ""}
          </p>
          <InteractiveBlocksProvider value={interactive}>
            {/* A fresh key resets the quiz's local attempt state for each question. */}
            <QuizBlockView
              key={current.itemId}
              block={current.quiz}
              renderMarkdown={plainMarkdownRenderer}
            />
          </InteractiveBlocksProvider>
          {answered ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                ref={nextRef}
                onClick={() => setIndex((value) => value + 1)}
                className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
              >
                {index + 1 < deck.length ? "Next question" : "See results"}
                <ArrowRightIcon aria-hidden="true" />
              </Button>
              {!answered.correct ? (
                <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
                  <Link {...relearnLink(projectId, current.unitId, current.quiz.concept, current.quiz.question)}>
                    Relearn this
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}
