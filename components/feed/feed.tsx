"use client"

/**
 * Owns the Review screen: a weakness-weighted run of questions and recaps on
 * studied material, shown one card at a time in the same frame as a drill,
 * with its server-backed answer flow and a project filter.
 *
 * Each visit is a session with a target: the questions due today, at most
 * `REVIEW_SESSION_SIZE`, or a short round of ten when nothing is due. The
 * header counts progress and the current run of right answers. Once the
 * target is reached, the next Next shows the session summary in the page,
 * and Keep going carries on with the feed. Cards load in pages and the next
 * page is fetched as the learner nears the end of the loaded cards.
 */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { useCallback, useEffect, useRef, useState } from "react"

import { FeedCardView } from "@/components/feed/feed-card"
import { SessionSummary } from "@/components/progress/session-summary"
import { TodayXpChip } from "@/components/progress/today-panel"
import { Button } from "@/components/ui/button"
import { CancelIcon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import type {
  AnswerRequest,
  AnswerResponse,
  EventRequest,
  FeedCard,
  FeedResponse,
  RecallReveal,
} from "@/lib/learning/client-contracts"
import { COMBO_START, comboBonus, XP } from "@/lib/progress"

const FEED_LIMIT = 20
const MAX_EMPTY_PAGE_HOPS = 3

/** Questions in a review round when nothing is due. */
const QUICK_ROUND_SIZE = 10

/** Sentinel value for the unfiltered project choice in the shadcn picker. */
const ALL_PROJECTS = "all"

/**
 * A selected project or topic filter, with empty values meaning all. Only the
 * project has a picker; a topic arrives from a link and can be cleared.
 */
type FeedFilter = {
  projectId: string
  topicId: string
}

/** Combines one feed page with existing cards and filter metadata. */
function mergeFeedResponses(
  current: FeedResponse | null,
  next: FeedResponse
): FeedResponse {
  // Cards repeat across rounds with a new key, so merge by key when present.
  const cards = new Map(
    (current?.cards ?? []).map((card) => [card.key ?? card.id, card])
  )
  for (const card of next.cards) cards.set(card.key ?? card.id, card)
  const projects = new Map(
    (current?.projects ?? []).map((project) => [project.id, project])
  )
  for (const project of next.projects) projects.set(project.id, project)
  const topics = new Map(
    (current?.topics ?? []).map((topic) => [topic.id, topic])
  )
  for (const topic of next.topics) topics.set(topic.id, topic)
  return {
    cards: [...cards.values()],
    projects: [...projects.values()],
    topics: [...topics.values()],
    isDone: next.isDone,
    continueCursor: next.continueCursor ?? null,
  }
}

/** Returns a stable client event identifier in browser environments. */
function createClientEventId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads a safe error message from a failed learning route response. */
async function readRouteError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown }
    return typeof payload.error === "string" ? payload.error : fallback
  } catch {
    return fallback
  }
}

/** Fetches one server-backed feed page for a filter and optional cursor. */
async function requestFeedPage(
  filter: FeedFilter,
  cursor: string | null | undefined,
  signal: AbortSignal
): Promise<FeedResponse> {
  const query = new URLSearchParams({ limit: String(FEED_LIMIT) })
  if (filter.projectId) query.set("projectId", filter.projectId)
  if (filter.topicId) query.set("topicId", filter.topicId)
  if (cursor) query.set("cursor", cursor)
  const response = await fetch(`/api/learning/feed?${query.toString()}`, {
    signal,
  })
  if (!response.ok) {
    throw new Error(
      await readRouteError(response, "Could not load the learning feed.")
    )
  }
  return (await response.json()) as FeedResponse
}

/** Renders the Review screen at `/review`. */
export function Feed({ initialFilter }: { initialFilter?: FeedFilter }) {
  const router = useRouter()
  const answerRequests = useRef(new Map<string, AnswerRequest>())
  const answeredCards = useRef(new Set<string>())
  const prefetchedAtCount = useRef<number | null>(null)
  const [data, setData] = useState<FeedResponse | null>(null)
  const [filter, setFilter] = useState<FeedFilter>(
    initialFilter ?? { projectId: "", topicId: "" }
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState("")
  const [loadMoreError, setLoadMoreError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const requestGeneration = useRef(0)
  const feedRequest = useRef<AbortController | null>(null)

  // The session: when it began, its target, and how it is going.
  const [sessionStartedAt] = useState(() => Date.now())
  const [tzOffsetMinutes] = useState(() => new Date().getTimezoneOffset())
  const now = useMinuteClock()
  const today = useQuery(api.progress.today, { tzOffsetMinutes, now })
  const [target, setTarget] = useState<number | null>(null)
  if (target === null && today)
    setTarget(today.review.count || QUICK_ROUND_SIZE)
  const [sessionAnswered, setSessionAnswered] = useState(0)
  // The run carries over from answers just before this page opened.
  const [run, setRun] = useState<number | null>(null)
  if (run === null && today) setRun(today.run)
  const [xpPop, setXpPop] = useState<{ amount: number; key: number } | null>(null)
  // The summary waits for Next after the target is reached, so the last answer's feedback stays readable.
  const [summaryDue, setSummaryDue] = useState(false)
  const [summaryShown, setSummaryShown] = useState(false)
  const [showingSummary, setShowingSummary] = useState(false)

  /** Counts one scored answer toward the session, the run, and the XP pop. */
  const countAnswer = useCallback(
    (correct: boolean) => {
      const nextRun = correct ? (run ?? 0) + 1 : 0
      setRun(nextRun)
      setXpPop({
        amount: correct ? XP.correctAnswer + comboBonus(nextRun) : XP.incorrectAnswer,
        key: Date.now(),
      })
      const next = sessionAnswered + 1
      setSessionAnswered(next)
      if (target !== null && next >= target && !summaryShown) {
        setSummaryShown(true)
        setSummaryDue(true)
      }
    },
    [run, sessionAnswered, target, summaryShown]
  )

  /** Opens a fresh workspace chat with the selected card queued as context. */
  const openCardChat = useCallback(
    (card: FeedCard): void => {
      const params = new URLSearchParams({
        cardProjectId: card.projectId,
        cardId: card.id,
      })
      router.push(`/chat?${params.toString()}`)
    },
    [router]
  )

  /** Loads the first bounded set of pages, skipping empty eligible pages. */
  useEffect(() => {
    const controller = new AbortController()
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    feedRequest.current?.abort()
    feedRequest.current = controller

    async function loadInitialPages() {
      let nextData: FeedResponse | null = null
      let cursor: string | null | undefined
      for (let pageIndex = 0; pageIndex < MAX_EMPTY_PAGE_HOPS; pageIndex += 1) {
        const page = await requestFeedPage(filter, cursor, controller.signal)
        if (requestGeneration.current !== generation) return
        nextData = mergeFeedResponses(nextData, page)
        cursor = page.continueCursor ?? null
        if (page.cards.length > 0 || !cursor) break
      }
      if (requestGeneration.current !== generation || !nextData) return
      setData(nextData)
      setActiveIndex(0)
    }

    void loadInitialPages()
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return
        if (requestGeneration.current !== generation) return
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load the learning feed."
        )
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          requestGeneration.current === generation
        )
          setLoading(false)
      })
    return () => {
      controller.abort()
      if (feedRequest.current === controller) feedRequest.current = null
    }
  }, [filter, reloadToken])

  const cardCount = data?.cards.length ?? 0

  /** Sends one answer request for server scoring and post-answer feedback. */
  const answerCard = useCallback(
    async (
      card: FeedCard,
      answer: AnswerRequest["answer"],
      confidence?: "guess"
    ): Promise<AnswerResponse> => {
      const key = JSON.stringify([card.id, answer, confidence ?? null])
      const request: AnswerRequest = answerRequests.current.get(key) ?? {
        projectId: card.projectId,
        itemId: card.id,
        clientEventId: createClientEventId(),
        occurredAt: Date.now(),
        answer,
        ...(confidence ? { confidence } : {}),
      }
      // A lost response retries the same attempt instead of counting it twice.
      answerRequests.current.set(key, request)
      const response = await fetch("/api/learning/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
      if (!response.ok) {
        throw new Error(
          await readRouteError(response, "Could not check that answer.")
        )
      }
      const result = (await response.json()) as AnswerResponse
      if (result.status !== "invalid" && !answeredCards.current.has(card.id)) {
        answeredCards.current.add(card.id)
        countAnswer(result.isCorrect)
      }
      return result
    },
    [countAnswer]
  )

  /** Fetches the answer to a question the learner is recalling from memory. */
  const revealCard = useCallback(async (card: FeedCard): Promise<RecallReveal> => {
    const response = await fetch("/api/learning/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reveal", projectId: card.projectId, itemId: card.id }),
    })
    if (!response.ok)
      throw new Error(await readRouteError(response, "Could not show the answer."))
    return (await response.json()) as RecallReveal
  }, [])

  /** Records whether the learner knew a recalled answer. */
  const recallCard = useCallback(
    async (card: FeedCard, knewIt: boolean): Promise<void> => {
      const response = await fetch("/api/learning/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "grade",
          projectId: card.projectId,
          itemId: card.id,
          clientEventId: createClientEventId(),
          occurredAt: Date.now(),
          outcome: knewIt ? "correct" : "incorrect",
        }),
      })
      if (!response.ok)
        throw new Error(await readRouteError(response, "Could not save that."))
      if (!answeredCards.current.has(card.id)) {
        answeredCards.current.add(card.id)
        countAnswer(knewIt)
      }
    },
    [countAnswer]
  )

  /** Records a passive skip while leaving the card answer state untouched. */
  const recordSkip = useCallback(async (card: FeedCard) => {
    const request: EventRequest = {
      projectId: card.projectId,
      itemId: card.id,
      clientEventId: createClientEventId(),
      occurredAt: Date.now(),
      eventType: "skip",
    }
    try {
      await fetch("/api/learning/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        keepalive: true,
      })
    } catch {
      // A skipped card remains skipped locally even when the event cannot sync.
    }
  }, [])

  /** Appends bounded continuation pages and ignores responses from old filters. */
  const loadMore = useCallback(async (): Promise<number> => {
    const currentData = data
    const cursor = currentData?.continueCursor ?? null
    if (!currentData || !cursor || loadingMore) return 0

    const controller = new AbortController()
    const generation = requestGeneration.current
    feedRequest.current?.abort()
    feedRequest.current = controller
    setLoadingMore(true)
    setLoadMoreError("")
    try {
      let nextData = currentData
      let nextCursor: string | null = cursor
      let addedCards = 0
      for (let pageIndex = 0; pageIndex < MAX_EMPTY_PAGE_HOPS; pageIndex += 1) {
        const page = await requestFeedPage(
          filter,
          nextCursor,
          controller.signal
        )
        if (requestGeneration.current !== generation) return 0
        const merged = mergeFeedResponses(nextData, page)
        addedCards += merged.cards.length - nextData.cards.length
        nextData = merged
        nextCursor = page.continueCursor ?? null
        if (addedCards > 0 || !nextCursor) break
      }
      if (requestGeneration.current !== generation) return 0
      setData(nextData)
      return addedCards
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return 0
      if (requestGeneration.current === generation) {
        setLoadMoreError(
          reason instanceof Error
            ? reason.message
            : "Could not load more cards."
        )
      }
      return 0
    } finally {
      if (feedRequest.current === controller) feedRequest.current = null
      if (requestGeneration.current === generation) setLoadingMore(false)
    }
  }, [data, filter, loadingMore])

  /** Prefetches once near each loaded boundary without endlessly scanning empty pages. */
  useEffect(() => {
    if (
      loading ||
      loadingMore ||
      loadMoreError ||
      !data?.continueCursor ||
      cardCount === 0 ||
      activeIndex < cardCount - 3 ||
      prefetchedAtCount.current === cardCount
    )
      return
    prefetchedAtCount.current = cardCount
    void loadMore()
  }, [
    activeIndex,
    cardCount,
    data?.continueCursor,
    loadMore,
    loading,
    loadingMore,
    loadMoreError,
  ])

  /**
   * Shows the card at `index`, loading the next page first when it is past
   * the loaded cards. Past the last card of the last page, the index rests on
   * `cardCount`, which shows the caught-up state.
   */
  function showCard(index: number) {
    window.scrollTo({ top: 0, behavior: "auto" })
    if (index < cardCount) {
      setActiveIndex(index)
      return
    }
    setActiveIndex(cardCount)
    if (data?.continueCursor)
      void loadMore().then((added) => {
        if (added) setActiveIndex(index)
      })
  }

  /**
   * Moves past a card: records a skip when it wasn't answered, shows the
   * session summary when the target was just reached, and otherwise shows the
   * next card.
   */
  function nextCard(card: FeedCard) {
    if (!answeredCards.current.has(card.id)) void recordSkip(card)
    if (summaryDue) {
      setSummaryDue(false)
      setShowingSummary(true)
      window.scrollTo({ top: 0, behavior: "auto" })
      return
    }
    showCard(activeIndex + 1)
  }

  /** Applies a filter and returns to the beginning of the feed. */
  function changeFilter(next: FeedFilter) {
    prefetchedAtCount.current = null
    requestGeneration.current += 1
    feedRequest.current?.abort()
    setData(null)
    setLoading(true)
    setLoadingMore(false)
    setError("")
    setLoadMoreError("")
    setShowingSummary(false)
    setFilter(next)
  }

  /** Reloads the feed after a failed first request. */
  function retry() {
    requestGeneration.current += 1
    feedRequest.current?.abort()
    setData(null)
    setLoading(true)
    setLoadingMore(false)
    setError("")
    setLoadMoreError("")
    setReloadToken((value) => value + 1)
  }

  const card = data?.cards[activeIndex]
  const projectTitles = new Map((data?.projects ?? []).map((project) => [project.id, project.title]))
  const topicTitle = filter.topicId
    ? (data?.topics.find((topic) => topic.id === filter.topicId)?.title ?? "One topic")
    : ""
  const answeredShown = target !== null ? Math.min(sessionAnswered, target) : 0

  return (
    <main className="mx-auto flex min-h-[calc(100svh-84px)] w-full max-w-2xl flex-col px-4 py-6 text-foreground sm:px-6 sm:py-10 md:min-h-svh">
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Review</h1>
        <div className="relative">
          <TodayXpChip />
          {xpPop ? (
            <span
              key={xpPop.key}
              aria-hidden="true"
              className="xp-pop absolute top-full right-3 mt-1 text-sm font-semibold text-brand tabular-nums"
            >
              +{xpPop.amount}
            </span>
          ) : null}
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select
            value={filter.projectId || ALL_PROJECTS}
            onValueChange={(value) =>
              changeFilter({ projectId: value === ALL_PROJECTS ? "" : value, topicId: "" })
            }
          >
            <SelectTrigger aria-label="Project" className="h-9 w-auto max-w-64 min-w-36 rounded-full px-3.5 text-sm">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {filter.projectId && !projectTitles.has(filter.projectId) ? (
                <SelectItem value={filter.projectId}>This project</SelectItem>
              ) : null}
              {(data?.projects ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {topicTitle ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => changeFilter({ ...filter, topicId: "" })}
              className="h-9 max-w-56 rounded-full px-3 text-sm"
              aria-label={`Clear the ${topicTitle} filter`}
            >
              <span className="truncate">{topicTitle}</span>
              <CancelIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {target !== null ? (
          <p className="flex items-center gap-3 text-sm text-muted-foreground tabular-nums">
            {run !== null && run >= COMBO_START ? (
              <span key={run} className="combo-chip font-medium text-brand">
                {run} in a row
                <span className="hidden sm:inline"> · +{comboBonus(run)} XP</span>
              </span>
            ) : null}
            <span>
              {answeredShown} of {target}
              <span className="sr-only"> answered this session</span>
            </span>
          </p>
        ) : null}
      </div>
      {target !== null ? (
        <Progress
          value={(answeredShown / target) * 100}
          aria-label={`${answeredShown} of ${target} answered this session`}
          className="mt-3 h-1"
        />
      ) : null}

      <div className="mt-8 flex-1">
        {loading ? (
          <FeedLoadingState />
        ) : error ? (
          <FeedMessage title="Review didn't load" detail={error}>
            <Button type="button" onClick={retry} className="mt-5 min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85">
              Try again
            </Button>
          </FeedMessage>
        ) : showingSummary ? (
          <SessionSummary
            since={sessionStartedAt}
            eyebrow="Review done"
            actions={
              <>
                <Button
                  type="button"
                  onClick={() => {
                    setShowingSummary(false)
                    showCard(activeIndex + 1)
                  }}
                  className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
                >
                  Keep going
                </Button>
                <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
                  <Link href="/">Back to Library</Link>
                </Button>
              </>
            }
          />
        ) : card ? (
          <FeedCardView
            key={card.key ?? card.id}
            card={card}
            context={[projectTitles.get(card.projectId), card.sourceLabel].filter(Boolean).join(" · ")}
            onAsk={openCardChat}
            onNext={nextCard}
            onAnswer={answerCard}
            onReveal={revealCard}
            onRecall={recallCard}
          />
        ) : loadingMore ? (
          <FeedLoadingState />
        ) : loadMoreError ? (
          <FeedMessage title="More cards didn't load" detail={loadMoreError}>
            <Button
              type="button"
              onClick={() => showCard(activeIndex)}
              className="mt-5 min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
            >
              Try again
            </Button>
          </FeedMessage>
        ) : cardCount ? (
          <FeedMessage title="You're caught up" detail="Nothing else is due. New cards appear as you learn more.">
            <Button asChild variant="outline" className="mt-5 min-h-11 rounded-full px-5">
              <Link href="/">Back to Library</Link>
            </Button>
          </FeedMessage>
        ) : (
          <FeedMessage
            title="Nothing to review yet"
            detail="Start a unit in one of your projects and its questions and recaps show up here."
          >
            <Button asChild className="mt-5 min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85">
              <Link href="/">Open your projects</Link>
            </Button>
          </FeedMessage>
        )}
      </div>
    </main>
  )
}

/** Displays a card-shaped loading state while cards load. */
function FeedLoadingState() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading cards">
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  )
}

/** A short message in place of a card, with its next action below it. */
function FeedMessage({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children?: React.ReactNode
}) {
  return (
    <section>
      <h2 className="font-heading text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      {children}
    </section>
  )
}
