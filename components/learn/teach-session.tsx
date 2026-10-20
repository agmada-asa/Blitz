"use client"

/**
 * The Teach screen for one unit: a live, source-grounded tutor session with
 * an outline to navigate, citations that open the original material, quizzes
 * that count as study evidence, and quick replies that keep the lesson moving.
 *
 * The session itself is a workspace chat (`purpose: "teach"`), so replies
 * stream through `/api/chat` and render from Convex as they are saved.
 */

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMinuteClock } from "@/hooks/use-minute-clock"

import {
  SourcePane,
  type LearningSourceSelection,
  type SourceSelection,
} from "@/components/chat/source-pane"
import { TeachDock, type TeachDockState } from "@/components/learn/teach-dock"
import { TeachLesson } from "@/components/learn/teach-lesson"
import {
  TeachOutlineList,
  TeachProgressBar,
} from "@/components/learn/teach-outline"
import { SessionSummary } from "@/components/progress/session-summary"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArrowDownIcon, ArrowLeftIcon, FileIcon } from "@/components/ui/icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ChatCitation } from "@/lib/citations"
import { consumeRelearn } from "@/lib/client/relearn"
import { restartSitting, sittingStart } from "@/lib/client/teach-sitting"
import { createClientMessageId, sendTeachTurn } from "@/lib/client/teach-turn"
import type { QuizBlock } from "@/lib/interactive-blocks"
import {
  isTeachPrecheck,
  parseTeachOutline,
  parseTeachPlan,
  parseTeachSectionMarker,
  TEACH_QUICK_REPLIES,
  teachJumpMessage,
  type TeachOutline,
  type TeachSectionPlan,
} from "@/lib/teach"

/** Scrolls an element into view, respecting the reduced-motion preference. */
function reveal(
  element: Element | null,
  block: ScrollLogicalPosition = "start"
) {
  if (!element) return
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  element.scrollIntoView({ block, behavior: reduce ? "auto" : "smooth" })
}

/**
 * Loads a unit and renders its Teach session, or a not-found state.
 * @param unitId The unit to teach.
 * @param ask A message to send once the session is ready, such as a Relearn request from Practice.
 */
export function TeachSession({
  unitId,
  ask,
}: {
  unitId: string
  ask?: string
}) {
  const unit = useQuery(api.units.get, { unitId: unitId as Id<"units"> })
  if (unit === undefined)
    return (
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </main>
    )
  if (unit === null)
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="font-heading text-2xl font-semibold">Unit not found</h1>
        <Button
          asChild
          variant="outline"
          className="mt-5 min-h-11 rounded-full"
        >
          <Link href="/">Back to projects</Link>
        </Button>
      </main>
    )
  return <LoadedTeachSession unit={unit} ask={ask} />
}

/** Unit data returned by `units.get`. */
type LoadedUnit = NonNullable<FunctionReturnType<typeof api.units.get>>

/** Runs the session for a loaded unit, sending `ask` once when it is provided. */
function LoadedTeachSession({ unit, ask }: { unit: LoadedUnit; ask?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const startTeach = useMutation(api.units.startTeach)
  const restartTeach = useMutation(api.units.restartTeach)
  const [chatId, setChatId] = useState<Id<"workspaceChats">>()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [source, setSource] = useState<
    SourceSelection | LearningSourceSelection
  >()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  // When this sitting began; "Finish for now" summarises from here.
  const [sittingStartedAt] = useState(() =>
    typeof window === "undefined" ? 0 : sittingStart(String(unit.id), Date.now())
  )
  const now = useMinuteClock()
  // XP earned this sitting, shown in the header as answers and sections land.
  const sitting = useQuery(
    api.progress.sessionSummary,
    sittingStartedAt
      ? {
          projectId: unit.projectId,
          unitId: unit.id,
          since: sittingStartedAt,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
          now,
        }
      : "skip"
  )
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const startingRef = useRef(false)
  const autoStartedRef = useRef<string | undefined>(undefined)
  const revealNextReplyRef = useRef(false)
  const restoredRef = useRef(false)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const askSentRef = useRef(false)

  // Opens the unit's session, creating it on first visit or after a restart.
  const sessionChatId = unit.teach?.chatId
  useEffect(() => {
    if (sessionChatId) return
    if (startingRef.current) return
    startingRef.current = true
    startTeach({ unitId: unit.id })
      .then((result) => setChatId(result.chatId))
      .catch(() => setError("This unit could not be opened. Try again."))
      .finally(() => {
        startingRef.current = false
      })
  }, [sessionChatId, startTeach, unit.id])
  const activeChatId = sessionChatId ?? chatId

  const chat = useQuery(
    api.workspaceChats.get,
    activeChatId ? { chatId: activeChatId } : "skip"
  )
  const answered = useQuery(
    api.teach.answeredQuizzes,
    activeChatId ? { chatId: activeChatId } : "skip"
  )
  const messages = useMemo(() => chat?.messages ?? [], [chat?.messages])
  const lastMessage = messages.at(-1)
  const running = chat?.status === "running" || sending

  // The saved outline wins; until the first reply finishes, read it live.
  const outline: TeachOutline | null = useMemo(() => {
    if (unit.outline) return unit.outline
    const first = messages.find((message) => message.role === "assistant")
    return first ? (parseTeachOutline(first.content) ?? null) : null
  }, [unit.outline, messages])

  // The latest section marker is the current section; every marker seen is a
  // taught section. Reading them from messages keeps progress live while a
  // reply streams; the saved values cover anything not loaded.
  const { sectionIndex, taughtSectionIds } = useMemo(() => {
    const taught = new Set(unit.teach?.taughtSectionIds ?? [])
    let index = Math.max(0, unit.teach?.sectionIndex ?? 0)
    if (!outline) return { sectionIndex: 0, taughtSectionIds: taught }
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const marker = parseTeachSectionMarker(message.content)
      if (marker?.kind === "done") index = outline.sections.length
      else if (marker) {
        const found = outline.sections.findIndex(
          (section) => section.id === marker.id
        )
        if (found >= 0) {
          index = found
          taught.add(marker.id)
        }
      }
    }
    return { sectionIndex: index, taughtSectionIds: taught }
  }, [outline, messages, unit.teach?.sectionIndex, unit.teach?.taughtSectionIds])
  const complete =
    Boolean(outline) && sectionIndex >= (outline?.sections.length ?? 0)

  // The saved plan wins; until the planning reply finishes, read it live.
  const plan: TeachSectionPlan | null = useMemo(() => {
    if (unit.plan) return unit.plan
    if (!outline) return null
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const found = parseTeachPlan(message.content, outline)
      if (found) return found
    }
    return null
  }, [unit.plan, outline, messages])
  // Sections after the current one that the tutor will still teach.
  const sectionsLeft = outline
    ? outline.sections.filter(
        (section, index) =>
          index > sectionIndex &&
          plan?.find((entry) => entry.id === section.id)?.mode !== "skip"
      ).length
    : 0
  // Celebrate only when the recap arrived in this sitting, not on every revisit.
  const finishedThisSitting =
    complete &&
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.createdAt >= sittingStartedAt &&
        parseTeachSectionMarker(message.content)?.kind === "done"
    )
  // The pre-check waits for `Plan my lesson` or `Skip the check`.
  const awaitingPlan =
    lastMessage?.role === "assistant" &&
    lastMessage.status === "completed" &&
    isTeachPrecheck(lastMessage.content)
  const precheckAnswered = awaitingPlan
    ? Object.keys(answered?.[lastMessage.id] ?? {}).length
    : 0

  /** Sends a learner message or quick reply, or resumes a paused reply. */
  const send = useCallback(
    async (message: string, continuationOf?: string) => {
      if (!activeChatId || sending || chat?.status === "running") return
      setSending(true)
      setError("")
      revealNextReplyRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      const result = await sendTeachTurn({
        chatId: activeChatId,
        message,
        ...(continuationOf ? { continuationOf } : {}),
        signal: controller.signal,
      })
      abortRef.current = undefined
      setSending(false)
      if (!result.ok && !result.paused) setError(result.error)
    },
    [activeChatId, sending, chat?.status]
  )

  // Sends a Relearn request from Practice once, then drops it from the URL so
  // a reload does not send it again. Only requests armed by Blitz's own
  // Relearn links are sent; any other `?ask=` is ignored.
  useEffect(() => {
    if (
      !ask?.trim() ||
      askSentRef.current ||
      !chat ||
      chat.status === "running"
    )
      return
    askSentRef.current = true
    router.replace(pathname, { scroll: false })
    if (!consumeRelearn(ask)) return
    autoStartedRef.current = chat.id
    const message = ask.trim().slice(0, 4_000)
    // Send after this effect so the request's state updates are not synchronous here.
    queueMicrotask(() => void send(message))
  }, [ask, chat, send, router, pathname])

  // Starts teaching as soon as a new session opens; the learner chose this unit.
  useEffect(() => {
    if (ask?.trim() && !askSentRef.current) return
    if (!chat || chat.status !== "idle" || chat.messages.length) return
    // Never teach from a title alone: wait until the unit has readable material.
    if (!unit.sources.some((source) => source.hasText)) return
    if (autoStartedRef.current === chat.id) return
    autoStartedRef.current = chat.id
    queueMicrotask(() => void send(TEACH_QUICK_REPLIES.start))
  }, [ask, chat, send, unit.sources])

  // Brings a new reply's opening into view once it appears.
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id
  useEffect(() => {
    if (!lastAssistantId || !revealNextReplyRef.current) return
    revealNextReplyRef.current = false
    reveal(document.querySelector(`[data-message-id="${lastAssistantId}"]`))
  }, [lastAssistantId])

  // Returning to a unit resumes at the latest reply. This runs once, when the
  // session first loads, so it never competes with revealing a new reply.
  useEffect(() => {
    if (restoredRef.current || !chat) return
    restoredRef.current = true
    if (chat.messages.length < 3) return
    const latest = chat.messages.findLast(
      (message) => message.role === "assistant"
    )
    if (latest)
      document
        .querySelector(`[data-message-id="${latest.id}"]`)
        ?.scrollIntoView({ block: "start" })
  }, [chat])

  /** Pauses the reply being written; the saved text stays and can be continued. */
  const pause = useCallback(async () => {
    const active = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.status === "running"
      )
    if (!activeChatId || !active) return
    const response = await fetch("/api/chat/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, messageId: active.id }),
    }).catch(() => null)
    abortRef.current?.abort()
    if (!response?.ok) setError("The reply could not be paused. Try again.")
  }, [activeChatId, messages])

  /** Scores a lesson quiz on the server and records it as study evidence. */
  const answerQuiz = useCallback(
    async (
      messageId: string,
      block: QuizBlock,
      selectedOptionIds: string[],
      confidence?: "guess"
    ) => {
      if (!activeChatId) return null
      const response = await fetch("/api/teach/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          messageId,
          quizId: block.id,
          selectedOptionIds,
          clientEventId: createClientMessageId(),
          ...(confidence ? { confidence } : {}),
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        correct?: unknown
        error?: unknown
      } | null
      if (!response.ok || typeof payload?.correct !== "boolean")
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "Your answer could not be saved."
        )
      return { correct: payload.correct }
    },
    [activeChatId]
  )

  const openCitation = useCallback(
    (messageId: string, citation: ChatCitation) => {
      if (!activeChatId) return
      setSource({
        chatId: activeChatId,
        messageId: messageId as Id<"workspaceChatMessages">,
        citationId: citation.id,
      })
    },
    [activeChatId]
  )

  /** Scrolls to a section already taught. */
  const openSection = useCallback(
    (index: number) => {
      const section = outline?.sections[index]
      if (!section) return
      setOutlineOpen(false)
      reveal(document.getElementById(`teach-section-${section.id}`))
    },
    [outline]
  )

  /** Asks the tutor to jump ahead to a section. */
  const jumpToSection = useCallback(
    (index: number) => {
      const section = outline?.sections[index]
      if (!section) return
      setOutlineOpen(false)
      void send(teachJumpMessage(index, section))
    },
    [outline, send]
  )

  // Shows a "latest" button when the learner has scrolled away from the end.
  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setShowJump(
      element.scrollHeight - element.scrollTop - element.clientHeight > 600
    )
  }, [])

  const projectHref = `/projects/${encodeURIComponent(String(unit.projectId))}`
  const hasMaterial = unit.sources.some((source) => source.hasText)
  const dockState: TeachDockState = !chat
    ? { kind: "starting" }
    : !hasMaterial && !messages.length
      ? { kind: "no-material" }
      : running
        ? { kind: outline ? "writing" : "starting" }
        : lastMessage?.role === "assistant" && lastMessage.status === "failed"
          ? { kind: "paused", hasText: Boolean(lastMessage.content.trim()) }
          : awaitingPlan
            ? { kind: "precheck", answered: precheckAnswered }
            : complete
              ? {
                  kind: "complete",
                  practiceHref: `${projectHref}/practice`,
                  nextUnit: unit.nextUnit
                    ? {
                        href: `${projectHref}/learn/${encodeURIComponent(String(unit.nextUnit.id))}`,
                        title: unit.nextUnit.title,
                      }
                    : null,
                }
              : {
                  kind: "ready",
                  isLastSection: Boolean(outline) && sectionsLeft === 0,
                }
  const currentSectionTitle =
    outline && !complete ? outline.sections[sectionIndex]?.title : undefined
  const progressLabel = outline
    ? awaitingPlan
      ? "Quick check"
      : complete
        ? "Unit complete"
        : `Section ${Math.min(sectionIndex + 1, outline.sections.length)} of ${outline.sections.length}`
    : running
      ? "Planning the lesson"
      : null

  const outlineList = outline ? (
    <TeachOutlineList
      outline={outline}
      sectionIndex={sectionIndex}
      taughtSectionIds={taughtSectionIds}
      plan={plan}
      busy={running}
      onOpenSection={openSection}
      onJumpToSection={jumpToSection}
    />
  ) : null

  return (
    // `overflow-hidden` keeps the Teach screen exactly one viewport tall, so
    // scrolling a reply into view never scrolls the page behind it.
    <div className="flex h-[100dvh] min-h-0 overflow-hidden md:h-svh">
      <aside
        aria-label="Unit outline"
        className={cn(
          "hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-border/70 px-3 py-5",
          // An open source needs the room on mid-size screens; the header still shows progress.
          source ? "2xl:flex" : "lg:flex"
        )}
      >
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mb-4 min-h-9 self-start"
        >
          <Link href={projectHref}>
            <ArrowLeftIcon aria-hidden="true" /> {unit.projectTitle}
          </Link>
        </Button>
        {outlineList ?? (
          <div className="space-y-2 px-3" aria-hidden="true">
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        )}
        {unit.sources.length ? (
          <section
            aria-label="Unit sources"
            className="mt-8 border-t border-border/70 pt-4"
          >
            <h2 className="px-3 text-xs font-medium text-muted-foreground">
              Sources
            </h2>
            <ul className="mt-2 space-y-0.5">
              {unit.sources.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!item.hasText}
                    onClick={() =>
                      setSource({
                        kind: "learning",
                        projectId: unit.projectId,
                        sourceId: item.id,
                        filename: item.filename,
                      })
                    }
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                  >
                    <FileIcon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">{item.filename}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border/70 px-4 pt-3 pb-3 sm:px-6">
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="icon"
              className={cn("size-10", source ? "2xl:hidden" : "lg:hidden")}
            >
              <Link
                href={projectHref}
                aria-label={`Back to ${unit.projectTitle}`}
              >
                <ArrowLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-heading text-lg font-semibold">
                {unit.title}
              </h1>
              {progressLabel ? (
                <p className="truncate text-xs text-muted-foreground">
                  {progressLabel}
                  {currentSectionTitle ? ` · ${currentSectionTitle}` : ""}
                </p>
              ) : null}
            </div>
            {sitting?.xp ? (
              <p
                className="hidden shrink-0 rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand tabular-nums sm:block"
                aria-label={`${sitting.xp} XP earned this session`}
              >
                +{sitting.xp} XP
              </p>
            ) : null}
            {chat && messages.length ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSummaryOpen(true)}
                className="min-h-10 shrink-0 rounded-full px-4"
              >
                Finish<span className="hidden sm:inline">&nbsp;for now</span>
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="min-h-10 rounded-full px-3"
                  aria-label="Unit options"
                >
                  ⋯
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={running}
                  onSelect={() => setConfirmRestart(true)}
                >
                  Start this unit over
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {outline ? (
            <>
              <TeachProgressBar
                outline={outline}
                sectionIndex={sectionIndex}
                taughtSectionIds={taughtSectionIds}
                plan={plan}
                className={cn("mt-3", source ? "hidden 2xl:flex" : "hidden lg:flex")}
              />
              {/* Narrow screens have no rail, so the progress bar opens the outline. */}
              <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${progressLabel}. Show outline`}
                    className={cn(
                      "mt-2 flex min-h-8 w-full items-center gap-2 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      source ? "2xl:hidden" : "lg:hidden"
                    )}
                  >
                    <TeachProgressBar
                      outline={outline}
                      sectionIndex={sectionIndex}
                      taughtSectionIds={taughtSectionIds}
                      plan={plan}
                    />
                    <ArrowDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[min(22rem,calc(100vw-2rem))] p-2"
                >
                  {outlineList}
                </PopoverContent>
              </Popover>
            </>
          ) : null}
        </header>

        <div className="relative min-h-0 flex-1">
          {/* `relative` contains KaTeX's absolutely positioned accessible copies. */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="relative h-full overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
              {chat ? (
                <TeachLesson
                  messages={messages}
                  outline={outline}
                  unitTitle={unit.title}
                  answered={answered}
                  onCitation={openCitation}
                  onQuizAnswer={answerQuiz}
                  onFollowUp={(text) => void send(text)}
                  busy={running}
                  sourceOpen={Boolean(source)}
                />
              ) : (
                <div className="space-y-3" aria-hidden="true">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              )}
              {complete && chat && !running ? (
                <div className="mt-12 rounded-2xl border border-border bg-card p-5 sm:p-6">
                  <SessionSummary
                    projectId={String(unit.projectId)}
                    unitId={String(unit.id)}
                    since={messages[0]?.createdAt ?? 0}
                    eyebrow="Unit complete"
                    title={`You finished ${unit.title}`}
                    celebrate={finishedThisSitting}
                  />
                </div>
              ) : null}
              {!unit.sources.some((source) => source.hasText) &&
              chat &&
              !messages.length ? (
                <p className="mt-6 text-sm text-muted-foreground">
                  This unit has no readable material yet.{" "}
                  <Link
                    href={projectHref}
                    className="underline underline-offset-4"
                  >
                    Add material
                  </Link>{" "}
                  for the tutor to teach from.
                </p>
              ) : null}
            </div>
          </div>
          {showJump ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                reveal(
                  lastAssistantId
                    ? document.querySelector(
                        `[data-message-id="${lastAssistantId}"]`
                      )
                    : null
                )
              }
              className="absolute bottom-4 left-1/2 min-h-10 -translate-x-1/2 rounded-full bg-background px-4 shadow-md dark:bg-background dark:hover:bg-muted"
            >
              Latest
              <ArrowDownIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <TeachDock
          state={dockState}
          error={error}
          onSend={(message) => void send(message)}
          onPause={() => void pause()}
          onResume={() =>
            lastMessage?.role === "assistant"
              ? void send("", lastMessage.id)
              : undefined
          }
        />
      </div>

      {source ? (
        // Citation readers size themselves; rail sources need a column width.
        <div
          className={cn(
            "contents",
            "kind" in source && "lg:block lg:w-[min(45vw,680px)] lg:shrink-0"
          )}
        >
          <SourcePane selection={source} onClose={() => setSource(undefined)} />
        </div>
      ) : null}

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader className="sr-only">
            <DialogTitle>This session</DialogTitle>
            <DialogDescription>
              What you covered since you sat down with this unit.
            </DialogDescription>
          </DialogHeader>
          {sittingStartedAt ? (
            <SessionSummary
              projectId={String(unit.projectId)}
              unitId={String(unit.id)}
              since={sittingStartedAt}
              eyebrow="This session"
              actions={
                <>
                  <Button
                    asChild
                    className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                  >
                    <Link
                      href={projectHref}
                      onClick={() => restartSitting(String(unit.id), Date.now())}
                    >
                      Done for now
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 rounded-full px-5"
                    onClick={() => setSummaryOpen(false)}
                  >
                    Keep learning
                  </Button>
                  <Button asChild variant="ghost" className="min-h-11 rounded-full px-4">
                    <Link
                      href={`${projectHref}/practice`}
                      onClick={() => restartSitting(String(unit.id), Date.now())}
                    >
                      Practice this unit
                    </Link>
                  </Button>
                </>
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start this unit over?</DialogTitle>
            <DialogDescription>
              The tutor plans and teaches the unit again from the beginning.
              Your answers to earlier questions stay in your practice history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestart(false)}>
              Keep going
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRestart(false)
                setChatId(undefined)
                restoredRef.current = false
                restartTeach({ unitId: unit.id }).catch(() =>
                  setError("The unit could not be restarted. Try again.")
                )
              }}
            >
              Start over
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
