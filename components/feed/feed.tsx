"use client"

/**
 * Owns the Review feed: a weakness-weighted scroll of questions and recaps on
 * studied material, its server-backed answer flow, and compact filters.
 *
 * Each visit is a session with a target: the questions due today, at most
 * `REVIEW_SESSION_SIZE`, or a short round of ten when nothing is due. The
 * header counts progress and the current run of right answers; reaching the
 * target opens the session summary, and Keep going carries on with the feed.
 */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery } from "convex/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { FeedCardView } from "@/components/feed/feed-card"
import { SessionSummary } from "@/components/progress/session-summary"
import { TodayXpChip } from "@/components/progress/today-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

/** Sentinel value representing an unfiltered project or topic selection in shadcn pickers. */
const ALL_FILTER_VALUE = "all"

/** A selected project or topic filter, with empty values meaning all. */
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

/** Renders the full-screen Review feed at `/review`. */
export function Feed({ initialFilter }: { initialFilter?: FeedFilter }) {
  const router = useRouter()
  const answerRequests = useRef(new Map<string, AnswerRequest>())
  const answeredCards = useRef(new Set<string>())
  const prefetchedAtCount = useRef<number | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<FeedResponse | null>(null)
  const [filter, setFilter] = useState<FeedFilter>(
    initialFilter ?? {
      projectId: "",
      topicId: "",
    }
  )
  const [draftFilter, setDraftFilter] = useState<FeedFilter>(filter)
  const [filterOpen, setFilterOpen] = useState(false)
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
  const [run, setRun] = useState(0)
  const [xpPop, setXpPop] = useState<{ amount: number; key: number } | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryShown, setSummaryShown] = useState(false)

  /** Counts one scored answer toward the session, the run, and the XP pop. */
  const countAnswer = useCallback(
    (correct: boolean) => {
      const nextRun = correct ? run + 1 : 0
      setRun(nextRun)
      setXpPop({
        amount: correct ? XP.correctAnswer + comboBonus(nextRun) : XP.incorrectAnswer,
        key: Date.now(),
      })
      const next = sessionAnswered + 1
      setSessionAnswered(next)
      if (target !== null && next >= target && !summaryShown) {
        setSummaryShown(true)
        // Let the answer's feedback show before the summary covers it.
        window.setTimeout(() => setSummaryOpen(true), 900)
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

  const topics = useMemo(
    () =>
      (data?.topics ?? []).filter(
        (topic) =>
          !draftFilter.projectId || topic.projectId === draftFilter.projectId
      ),
    [data?.topics, draftFilter.projectId]
  )

  const selectedProjectId =
    draftFilter.projectId &&
    (!data ||
      data.projects.some((project) => project.id === draftFilter.projectId))
      ? draftFilter.projectId
      : ALL_FILTER_VALUE

  const selectedTopicId =
    draftFilter.topicId &&
    topics.some((topic) => topic.id === draftFilter.topicId)
      ? draftFilter.topicId
      : ALL_FILTER_VALUE

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
      feedRef.current?.scrollTo({ top: 0, behavior: "auto" })
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

  /** Scrolls to one card while respecting the user's motion preference. */
  const scrollToCard = useCallback(
    (index: number) => {
      const container = feedRef.current
      if (!container || !cardCount) return
      const boundedIndex = Math.max(0, Math.min(index, cardCount - 1))
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      container.scrollTo({
        top: boundedIndex * container.clientHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      })
      setActiveIndex(boundedIndex)
    },
    [cardCount]
  )

  /** Keeps keyboard navigation aligned with the currently visible card. */
  useEffect(() => {
    const container = feedRef.current
    if (!container) return
    const feedContainer = container
    const handleScroll = () => {
      const nextIndex =
        Math.round(feedContainer.scrollTop / feedContainer.clientHeight)
      setActiveIndex(
        Math.max(0, Math.min(nextIndex, Math.max(cardCount - 1, 0)))
      )
    }
    feedContainer.addEventListener("scroll", handleScroll, { passive: true })
    return () => feedContainer.removeEventListener("scroll", handleScroll)
  }, [cardCount])

  /** Maps arrow and page keys to feed movement without capturing form input. */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (filterOpen) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)
      ) {
        return
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault()
        scrollToCard(activeIndex + 1)
      }
      if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault()
        scrollToCard(activeIndex - 1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeIndex, filterOpen, scrollToCard])

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

  /** Records a skip and advances without wrapping to an earlier card. */
  function skipCard(card: FeedCard, index: number) {
    if (!answeredCards.current.has(card.id)) void recordSkip(card)
    if (index + 1 < cardCount) {
      scrollToCard(index + 1)
      return
    }
    if (data?.continueCursor) {
      const previousCount = cardCount
      void loadMore().then((addedCards) => {
        if (!addedCards) return
        window.requestAnimationFrame(() => {
          const container = feedRef.current
          if (!container) return
          const reducedMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
          ).matches
          container.scrollTo({
            top: previousCount * container.clientHeight,
            behavior: reducedMotion ? "auto" : "smooth",
          })
          setActiveIndex(previousCount)
        })
      })
      return
    }
    const container = feedRef.current
    if (!container) return
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    container.scrollTo({
      top: cardCount * container.clientHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    })
  }

  /** Applies the draft filter and returns to the beginning of the feed. */
  function applyFilters() {
    prefetchedAtCount.current = null
    requestGeneration.current += 1
    feedRequest.current?.abort()
    setData(null)
    setLoading(true)
    setLoadingMore(false)
    setError("")
    setLoadMoreError("")
    const validTopicId =
      draftFilter.topicId &&
      topics.some((topic) => topic.id === draftFilter.topicId)
        ? draftFilter.topicId
        : ""
    setFilter({
      projectId: draftFilter.projectId,
      topicId: validTopicId,
    })
    setFilterOpen(false)
  }

  const hasCards = Boolean(data?.cards.length)
  const hasMore =
    data?.continueCursor !== null && data?.continueCursor !== undefined

  return (
    <main className="feed-backdrop relative isolate h-[calc(100svh-68px-env(safe-area-inset-bottom))] overflow-hidden bg-background text-foreground selection:bg-brand selection:text-brand-foreground md:h-svh">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-end gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-8 sm:pt-6">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-sm tabular-nums">
          {target !== null ? (
            <p className="flex h-10 items-center rounded-full border border-border/80 bg-background/80 px-3.5 text-muted-foreground backdrop-blur-md">
              {Math.min(sessionAnswered, target)} of {target}
              <span className="sr-only"> answered this session</span>
            </p>
          ) : null}
          {run >= COMBO_START ? (
            <p
              key={run}
              className="combo-chip flex h-10 items-center rounded-full border border-brand/30 bg-brand/10 px-3.5 font-medium text-brand backdrop-blur-md"
            >
              {run} in a row · +{comboBonus(run)} XP
            </p>
          ) : null}
        </div>
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
        <Dialog
          open={filterOpen}
          onOpenChange={(open) => {
            if (open) setDraftFilter(filter)
            setFilterOpen(open)
          }}
        >
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label="Filter"
              className="pointer-events-auto h-10 w-10 rounded-full border-border/80 bg-background/80 px-0 text-sm text-muted-foreground backdrop-blur-md hover:bg-muted hover:text-foreground sm:w-auto sm:px-3.5"
            >
              <HugeiconsIcon
                icon={FilterHorizontalIcon}
                aria-hidden="true"
                className="size-4"
              />
              <span className="sr-only sm:not-sr-only">Filter</span>
            </Button>
          </DialogTrigger>
          <DialogContent
            aria-describedby={undefined}
            className="sm:max-w-sm"
            showCloseButton
          >
            <DialogHeader>
              <DialogTitle>
                Filter feed
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <label
                  className="block text-sm font-medium text-foreground"
                  htmlFor="feed-project-filter"
                >
                  Project
                </label>
                <Select
                  value={selectedProjectId}
                  onValueChange={(value) =>
                    setDraftFilter({
                      projectId: value === ALL_FILTER_VALUE ? "" : value,
                      topicId: "",
                    })
                  }
                >
                  <SelectTrigger
                    id="feed-project-filter"
                    className="h-11 rounded-xl px-3"
                    aria-label="Filter by project"
                  >
                    <SelectValue placeholder="All projects" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER_VALUE}>
                      All projects
                    </SelectItem>
                    {(data?.projects ?? []).map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label
                  className="block text-sm font-medium text-foreground"
                  htmlFor="feed-topic-filter"
                >
                  Topic
                </label>
                <Select
                  value={selectedTopicId}
                  onValueChange={(value) =>
                    setDraftFilter((current) => ({
                      ...current,
                      topicId: value === ALL_FILTER_VALUE ? "" : value,
                    }))
                  }
                >
                  <SelectTrigger
                    id="feed-topic-filter"
                    className="h-11 rounded-xl px-3"
                    aria-label="Filter by topic"
                  >
                    <SelectValue placeholder="All topics" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER_VALUE}>
                      All topics
                    </SelectItem>
                    {topics.map((topic) => (
                      <SelectItem key={topic.id} value={topic.id}>
                        {topic.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFilterOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={applyFilters}
                className="bg-brand text-brand-foreground hover:bg-brand/85"
              >
                Apply filters
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <FeedLoadingState />
      ) : error ? (
        <FeedErrorState
          message={error}
          onRetry={() => {
            requestGeneration.current += 1
            feedRequest.current?.abort()
            setData(null)
            setLoading(true)
            setLoadingMore(false)
            setError("")
            setLoadMoreError("")
            setReloadToken((value) => value + 1)
          }}
        />
      ) : !hasCards ? (
        <FeedEmptyState
          hasMore={hasMore}
          loadingMore={loadingMore}
          error={loadMoreError}
          onLoadMore={() => void loadMore()}
        />
      ) : (
        <div
          ref={feedRef}
          tabIndex={0}
          aria-label="Learning feed"
          className="h-full snap-y snap-mandatory [scrollbar-width:none] overflow-y-auto overscroll-y-contain scroll-smooth outline-none focus:outline-none focus-visible:outline-none [&::-webkit-scrollbar]:hidden"
        >
          {data?.cards.map((card, index) => (
            <FeedCardView
              key={card.key ?? card.id}
              card={card}
              onAsk={openCardChat}
              onSkip={(nextCard) => skipCard(nextCard, index)}
              onAnswer={answerCard}
              onReveal={revealCard}
              onRecall={recallCard}
            />
          ))}
          {hasMore ? (
            <FeedLoadMoreState
              loading={loadingMore}
              error={loadMoreError}
              onLoadMore={() => void loadMore()}
            />
          ) : (
            <FeedEndState />
          )}
        </div>
      )}

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" showCloseButton>
          <DialogHeader className="sr-only">
            <DialogTitle>Review session summary</DialogTitle>
            <DialogDescription>What this review session added up to.</DialogDescription>
          </DialogHeader>
          <SessionSummary
            since={sessionStartedAt}
            eyebrow="Review done"
            actions={
              <>
                <Button
                  type="button"
                  onClick={() => setSummaryOpen(false)}
                  className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                >
                  Keep going
                </Button>
                <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
                  <Link href="/">Back to Library</Link>
                </Button>
              </>
            }
          />
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** Displays a quiet card-shaped loading state while the feed request resolves. */
function FeedLoadingState() {
  return (
    <div
      className="flex h-full items-center px-4 pt-20 pb-10 sm:px-8"
      role="status"
      aria-label="Loading feed"
    >
      <div className="mx-auto w-full max-w-[680px] space-y-6">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-24 w-4/5" />
        <Skeleton className="h-5 w-full max-w-xl" />
        <Skeleton className="h-5 w-2/3" />
      </div>
    </div>
  )
}

/** Explains a recoverable feed request failure and offers a retry. */
function FeedErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <section className="flex h-full items-center justify-center px-5 text-center">
      <div className="max-w-sm">
        <h1 className="text-3xl font-medium tracking-[-0.04em] text-foreground">
          Feed unavailable
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{message}</p>
        <Button
          type="button"
          onClick={onRetry}
          className="mt-6 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
        >
          Try again
        </Button>
      </div>
    </section>
  )
}

/** Provides the useful next action when no generated material is available. */
function FeedEmptyState({
  hasMore,
  loadingMore,
  error,
  onLoadMore,
}: {
  hasMore: boolean
  loadingMore: boolean
  error: string
  onLoadMore: () => void
}) {
  return (
    <section className="flex h-full items-center justify-center px-5 text-center">
      <div className="max-w-sm">
        <h1 className="text-3xl font-medium tracking-[-0.04em] text-foreground">
          {hasMore ? "No cards here yet" : "Start a unit to fill your feed"}
        </h1>
        {error ? (
          <p className="mt-3 text-sm leading-relaxed text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {hasMore ? (
          <Button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="mt-6 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : (
          <Button
            asChild
            className="mt-6 h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
          >
            <Link href="/">Open your modules</Link>
          </Button>
        )}
      </div>
    </section>
  )
}

/** Offers a bounded continuation action at the end of loaded cards. */
function FeedLoadMoreState({
  loading,
  error,
  onLoadMore,
}: {
  loading: boolean
  error: string
  onLoadMore: () => void
}) {
  return (
    <section className="flex h-svh snap-start items-center justify-center px-5 text-center">
      <div className="max-w-sm">
        {error ? (
          <p className="mb-4 text-sm leading-relaxed text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85"
        >
          {loading ? "Loading…" : "Load more"}
        </Button>
      </div>
    </section>
  )
}

/** Gives the learner a truthful stopping point when the server is exhausted. */
function FeedEndState() {
  return (
    <section className="flex h-svh snap-start items-center justify-center px-5 text-center">
      <p className="text-sm text-muted-foreground">You’re caught up</p>
    </section>
  )
}
