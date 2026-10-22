/**
 * @file ocean-app/src/screens/review.tsx
 * @description Review on the phone: the same feed as Blitz's /review, full screen, one card per
 * page. Cards are Blitz's own `FeedCardView`, so every question type looks and works as it does
 * on the Mac; answers go to `app_answer` and Blitz scores them, so they count towards XP, the
 * streak and when each concept is due. "Ask in chat" starts an Ocean chat about the card.
 */

import * as React from "react"
import { FeedCardView } from "@/components/feed/feed-card"
import { Button } from "@/components/ui/button"
import type {
  AnswerResponse,
  FeedCard,
  FeedResponse,
  LearningAnswer,
  RecallReveal,
} from "@/lib/learning/client-contracts"
import { askOcean, callTool, setContext } from "../bridge"
import { back, eventId } from "../data"

/** Cards left before the end that start loading the next page. */
const PREFETCH_CARDS = 3

/**
 * Describes a card for Ocean, so a chat started from it knows the question and its options.
 *
 * @param card The card on screen.
 * @returns A short description with the ids an agent needs.
 */
function describe(card: FeedCard): string {
  if (card.type === "explain")
    return `a Blitz recap card "${card.title}" (${card.sourceLabel}): ${card.body}`
  const options = card.options?.length
    ? ` Options: ${card.options.map((option) => `${option.id}) ${option.text}`).join("; ")}.`
    : ""
  return `a Blitz review question from "${card.sourceLabel}" (module id ${card.projectId}): ${card.question}${options}`
}

/**
 * The Review feed. It keeps loading pages as the user nears the end, and never reloads on its own,
 * so their place isn't lost when Ocean announces their own answers.
 *
 * @param props.module Only this module's material, or every started unit when absent.
 */
export function Review({ module }: { module?: string }) {
  const [cards, setCards] = React.useState<FeedCard[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [state, setState] = React.useState<"loading" | "ready" | "done">(
    "loading"
  )
  const [error, setError] = React.useState<string | null>(null)
  const [score, setScore] = React.useState({ answered: 0, correct: 0 })
  const [asked, setAsked] = React.useState(false)
  const answered = React.useRef(new Set<string>())
  const loading = React.useRef(false)
  const feed = React.useRef<HTMLDivElement>(null)

  /**
   * Loads one page and adds its cards; the first page replaces nothing, later ones append.
   *
   * @param after The previous page's cursor, or undefined for the first page.
   */
  const load = React.useCallback(
    (after?: string) => {
      if (loading.current) return
      loading.current = true
      callTool<FeedResponse>("app_review", {
        ...(module ? { module } : {}),
        ...(after ? { cursor: after } : {}),
      })
        .then(
          (page) => {
            setError(null)
            setCards((current) => [...current, ...page.cards])
            setCursor(page.continueCursor ?? null)
            setState(page.cards.length || after ? "ready" : "done")
          },
          (failure: unknown) =>
            setError(
              failure instanceof Error
                ? failure.message
                : "Review couldn't load."
            )
        )
        .finally(() => {
          loading.current = false
        })
    },
    [module]
  )

  // The app remounts Review for another module (see its key in main.tsx), so this runs once.
  React.useEffect(() => load(), [load])

  /** Loads the next page when the card shown is close to the last one. */
  const nearEnd = (index: number) => {
    if (cursor && index >= cards.length - PREFETCH_CARDS) load(cursor)
  }

  /** Scrolls to the card after this one. */
  const advance = (card: FeedCard) => {
    const index = cards.findIndex(
      (entry) => (entry.key ?? entry.id) === (card.key ?? card.id)
    )
    const next = feed.current?.children[index + 1] as HTMLElement | undefined
    next?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    })
    nearEnd(index + 1)
  }

  /** Sends an answer for Blitz to score, and counts it once it's recorded. */
  const answer = async (
    card: FeedCard,
    value: LearningAnswer,
    confidence?: "guess"
  ): Promise<AnswerResponse> => {
    const result = await callTool<AnswerResponse>("app_answer", {
      module: card.projectId,
      item: card.id,
      event: eventId(),
      at: Date.now(),
      answer: value,
      ...(confidence ? { confidence } : {}),
    })
    if (result.status !== "invalid") {
      answered.current.add(card.key ?? card.id)
      setScore((current) => ({
        answered: current.answered + 1,
        correct: current.correct + (result.isCorrect ? 1 : 0),
      }))
    }
    return result
  }

  /** Shows the answer to a question the user is answering from memory. */
  const reveal = (card: FeedCard): Promise<RecallReveal> =>
    callTool<RecallReveal>("app_reveal", { module: card.projectId, item: card.id })

  /** Records whether the user knew a recalled answer, and counts it. */
  const recall = async (card: FeedCard, knewIt: boolean): Promise<void> => {
    await callTool("app_recall", {
      module: card.projectId,
      item: card.id,
      event: eventId(),
      at: Date.now(),
      knewIt,
    })
    answered.current.add(card.key ?? card.id)
    setScore((current) => ({
      answered: current.answered + 1,
      correct: current.correct + (knewIt ? 1 : 0),
    }))
  }

  /** Moves on; a question left unanswered is recorded as skipped, which doesn't change when it's due. */
  const skip = (card: FeedCard) => {
    if (card.type !== "explain" && !answered.current.has(card.key ?? card.id))
      void callTool("app_skip", {
        module: card.projectId,
        item: card.id,
        event: eventId(),
        at: Date.now(),
      }).catch(() => undefined)
    advance(card)
  }

  /** Starts an Ocean chat about the card. */
  const ask = (card: FeedCard) => {
    setContext(describe(card))
    const answeredIt = answered.current.has(card.key ?? card.id)
    void askOcean(
      answeredIt
        ? "Explain this question and the idea behind it."
        : "Help me think through this question without giving the answer away."
    ).then(() => {
      setAsked(true)
      window.setTimeout(() => setAsked(false), 4000)
    })
  }

  /** Loads more when the user scrolls by hand towards the end. */
  const scrolled = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const index = Math.round(
      element.scrollTop / Math.max(1, element.clientHeight)
    )
    nearEnd(index)
  }

  return (
    <div className="relative h-full">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-background/85 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <Button
          variant="outline"
          size="lg"
          className="rounded-full px-4"
          onClick={back}
        >
          Done
        </Button>
        <span className="flex-1 text-right text-[13px] text-muted-foreground">
          {score.answered
            ? `${score.correct} of ${score.answered} right`
            : module
              ? "This module"
              : "Every started unit"}
        </span>
      </div>

      {asked ? (
        <p
          role="status"
          className="absolute inset-x-4 bottom-4 z-10 rounded-2xl bg-foreground px-4 py-3 text-[14px] text-background"
        >
          Ocean&apos;s on it. The answer comes back as a chat.
        </p>
      ) : null}

      {cards.length ? (
        <div
          ref={feed}
          onScroll={scrolled}
          className="h-full snap-y snap-mandatory overflow-y-auto overscroll-contain"
        >
          {cards.map((card) => (
            <FeedCardView
              key={card.key ?? card.id}
              card={card}
              onAnswer={answer}
              onReveal={reveal}
              onRecall={recall}
              onSkip={skip}
              onAsk={ask}
            />
          ))}
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center px-6 text-[15px]">
          {error ? (
            <>
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                size="lg"
                className="mt-3 w-fit"
                onClick={() => {
                  setError(null)
                  load()
                }}
              >
                Try again
              </Button>
            </>
          ) : state === "done" ? (
            <p className="text-muted-foreground">
              Nothing to review yet. Review asks about units you&apos;ve
              started, so teach one in Blitz first.
            </p>
          ) : (
            <p className="text-muted-foreground">Loading…</p>
          )}
        </div>
      )}
    </div>
  )
}
