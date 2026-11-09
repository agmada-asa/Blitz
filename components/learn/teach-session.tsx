"use client"

/**
 * The Teach screen for one unit: a live, source-grounded tutor session with
 * an outline to navigate, citations that open the original material, quizzes
 * that count as study evidence, and quick replies that keep the lesson moving.
 *
 * The session itself is a workspace chat (`purpose: "teach"`), so replies
 * stream through `/api/chat` and render from Convex as they are saved.
 *
 * Opening a new session prewarms the reply provider. Where the provider
 * supports it, Unit options shows how full the session's context is (with
 * Compact now in its dialog).
 *
 * When files arrive after the lesson was planned, the header offers to update
 * it (`teach-update-notice.tsx`). The update queues the sections it changes, so
 * `Next section` works through them with no extra controls.
 *
 * Questions go to a side chat on the right rather than into the lesson: an
 * ordinary chat of its own, so the lesson's conversation stays on its plan and
 * a question can be asked while the tutor is writing. A passage picked from
 * the lesson (`teach-ask-overlay.tsx`) is quoted into it.
 */

import Link from "next/link"
import { TalkButton, useVoiceSession, VoiceBar, VoiceError, voiceCutNote, type VoiceReply } from "@/components/voice/voice-conversation"
import type { LessonVoice } from "@/components/chat/chat-workspace"
import { spokenReplyText } from "@/components/learn/teach-voice"
import { usePathname, useRouter } from "next/navigation"
import { useMutation, useQuery } from "convex/react"
import { BlitzLogo } from "@/components/blitz-logo"
import { ProviderHandoffOffer } from "@/components/chat/provider-handoff-offer"
import { TeachAskOverlay } from "@/components/learn/teach-ask-overlay"
import {
  LearningSidePane,
  type LearningSidePaneTab,
} from "@/components/projects/learning-side-pane"
import {
  ReadRepliesToggle,
  useReadRepliesSetting,
  useReplyReader,
} from "@/components/learn/teach-voice"
import type { FunctionReturnType } from "convex/server"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMinuteClock } from "@/hooks/use-minute-clock"

import type {
  LearningSourceSelection,
  SourceSelection,
} from "@/components/chat/source-pane"
import {
  TeachContextDetails,
  TeachContextMeter,
} from "@/components/learn/teach-context-meter"
import { TeachDock, type TeachDockState } from "@/components/learn/teach-dock"
import { TeachLesson } from "@/components/learn/teach-lesson"
import { TeachUpdateNotice } from "@/components/learn/teach-update-notice"
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
  DropdownMenuSeparator,
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
import type { LessonPassage } from "@/lib/client/lesson-passage-dom"
import { consumeRelearn } from "@/lib/client/relearn"
import { restartSitting, sittingStart } from "@/lib/client/teach-sitting"
import { MAX_LESSON_SECTION_CHARACTERS } from "@/lib/lesson-passage"
import {
  compactTeachSession,
  createClientMessageId,
  prewarmTeachSession,
  sendTeachTurn,
} from "@/lib/client/teach-turn"
import { startTeachUpdate } from "@/lib/client/teach-update"
import { providerThreadFeatures } from "@/lib/provider-thread-features"
import type { QuizBlock } from "@/lib/interactive-blocks"
import {
  isTeachPrecheck,
  parseTeachOutline,
  parseTeachPlan,
  parseTeachSectionMarker,
  stripTeachMarkers,
  TEACH_QUICK_REPLIES,
  teachJumpMessage,
  type TeachOutline,
  type TeachSectionPlan,
} from "@/lib/teach"
import {
  followTeachReplies,
  isTeachUpdateRunning,
  nextTeachTarget,
  type TeachReplyMarker,
} from "@/lib/teach-updates"

/** How long a Compact now request holds a session, matching the server's lease. */
const COMPACTION_LEASE_MS = 5 * 60 * 1_000

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

/**
 * A spoken question for the side chat. `before` is set once it is sent: the messages already in the
 * chat then, so the first reply not among them is its answer.
 */
type VoiceAsk = NonNullable<LessonVoice["ask"]> & { before?: string[] }

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
  const [sideChatOpen, setSideChatOpen] = useState(false)
  const [sideTab, setSideTab] = useState<LearningSidePaneTab>("chat")
  /** Passage waiting in the side chat's composer. */
  const [quote, setQuote] = useState<LessonPassage & { id: string }>()
  const setTeachSideChat = useMutation(api.workspaceChats.setTeachSideChat)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const unitOptionsRef = useRef<HTMLButtonElement>(null)
  /** Returns keyboard focus to the menu after one of its dialogs closes. */
  const focusUnitOptions = useCallback((event: Event) => {
    event.preventDefault()
    requestAnimationFrame(() => unitOptionsRef.current?.focus())
  }, [])
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
  const columnRef = useRef<HTMLDivElement>(null)
  const startingRef = useRef(false)
  const autoStartedRef = useRef<string | undefined>(undefined)
  const revealNextReplyRef = useRef(false)
  const restoredRef = useRef(false)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const askSentRef = useRef(false)
  const prewarmedRef = useRef<string | undefined>(undefined)
  const [compactRequested, setCompactRequested] = useState(false)
  const [compactError, setCompactError] = useState("")

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
  const features = providerThreadFeatures(chat?.providerId)
  const compacting =
    compactRequested ||
    Boolean(chat?.compactingSince && chat.compactingSince > now - COMPACTION_LEASE_MS)
  const hasReadableMaterial = unit.sources.some((source) => source.hasText)
  const lessonUpdate = unit.teach?.update ?? null
  const updating = isTeachUpdateRunning(lessonUpdate?.run, now)
  const [startingUpdate, setStartingUpdate] = useState(false)
  const [updateStartError, setUpdateStartError] = useState<string | null>(null)

  /** Starts updating the lesson from its new files; progress arrives from Convex. */
  const updateLesson = useCallback(async () => {
    setStartingUpdate(true)
    setUpdateStartError(null)
    setUpdateStartError(await startTeachUpdate(String(unit.id)))
    setStartingUpdate(false)
  }, [unit.id])

  // Starts the reply provider while the session opens, so the first reply
  // comes sooner. The server prewarms only a session with no thread yet.
  useEffect(() => {
    if (!activeChatId || !hasReadableMaterial) return
    if (prewarmedRef.current === activeChatId) return
    prewarmedRef.current = activeChatId
    prewarmTeachSession(activeChatId)
  }, [activeChatId, hasReadableMaterial])

  // The saved outline wins; until the first reply finishes, read it live.
  const outline: TeachOutline | null = useMemo(() => {
    if (unit.outline) return unit.outline
    const first = messages.find((message) => message.role === "assistant")
    return first ? (parseTeachOutline(first.content) ?? null) : null
  }, [unit.outline, messages])
  // Hands-free: new replies are read aloud while the learner has it on.
  const [readReplies, setReadReplies] = useReadRepliesSetting()

  const lessonUpdates = useMemo(() => chat?.teachUpdates ?? [], [chat?.teachUpdates])
  const lastUpdateAt = lessonUpdates.at(-1)?.at ?? 0
  // Each reply's section marker, read once for everything below.
  const replyMarkers: TeachReplyMarker[] = useMemo(
    () =>
      messages.flatMap((message) => {
        if (message.role !== "assistant") return []
        const marker = parseTeachSectionMarker(message.content)
        if (!marker) return []
        return [
          marker.kind === "done"
            ? { id: message.id, createdAt: message.createdAt, done: true }
            : { id: message.id, createdAt: message.createdAt, sectionId: marker.id },
        ]
      }),
    [messages]
  )
  // The latest section marker is the current section; every marker seen is a
  // taught section. Reading them from messages keeps progress live while a
  // reply streams; the saved values cover anything not loaded. Markers older
  // than the latest lesson update no longer move the learner.
  const savedPending = unit.teach?.update?.pendingSections
  const { sectionIndex, taughtSectionIds, pendingSections } = useMemo(() => {
    if (!outline)
      return {
        sectionIndex: 0,
        taughtSectionIds: new Set(unit.teach?.taughtSectionIds ?? []),
        pendingSections: [],
      }
    const followed = followTeachReplies(
      {
        sectionIndex: Math.max(0, unit.teach?.sectionIndex ?? 0),
        taughtSectionIds: unit.teach?.taughtSectionIds ?? [],
        pending: savedPending ?? [],
        lastUpdateAt,
        sections: outline.sections,
      },
      replyMarkers
    )
    return {
      sectionIndex: followed.sectionIndex,
      taughtSectionIds: followed.taughtSectionIds,
      pendingSections: followed.pending,
    }
  }, [outline, replyMarkers, lastUpdateAt, savedPending, unit.teach?.sectionIndex, unit.teach?.taughtSectionIds])
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
  // Sections after the current one that the tutor will still teach. Once a
  // lesson has been updated, the queue decides what is left, as it does on the server.
  const sectionsLeft = !outline
    ? 0
    : lessonUpdates.length
      ? nextTeachTarget({
          outline,
          plan,
          taughtSectionIds,
          pending: pendingSections,
          sectionIndex,
        }).kind === "done"
        ? 0
        : 1
      : outline.sections.filter(
          (section, index) =>
            index > sectionIndex &&
            plan?.find((entry) => entry.id === section.id)?.mode !== "skip"
        ).length
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

  /** Sends a quick reply or resumes a paused reply. */
  const send = useCallback(
    async (message: string, continuationOf?: string, spoken = false) => {
      if (!activeChatId || sending || chat?.status === "running") return false
      setSending(true)
      setError("")
      revealNextReplyRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      const result = await sendTeachTurn({
        chatId: activeChatId,
        spoken,
        message,
        ...(continuationOf ? { continuationOf } : {}),
        signal: controller.signal,
      })
      abortRef.current = undefined
      setSending(false)
      if (!result.ok && !result.paused) setError(result.error)
      return result.ok || Boolean(result.paused)
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

  /** Compacts the session's context now, from the context sheet. */
  const compactNow = useCallback(async () => {
    if (!activeChatId || compacting) return
    setCompactRequested(true)
    setCompactError("")
    const failure = await compactTeachSession(activeChatId)
    setCompactRequested(false)
    if (failure) setCompactError(failure)
  }, [activeChatId, compacting])

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

  /** Shows a source in the side panel, leaving an open side chat one tab away. */
  const showSource = useCallback(
    (selection: SourceSelection | LearningSourceSelection) => {
      setSource(selection)
      setSideTab("source")
    },
    []
  )

  const openCitation = useCallback(
    (messageId: string, citation: ChatCitation) => {
      if (!activeChatId) return
      showSource({
        chatId: activeChatId,
        messageId: messageId as Id<"workspaceChatMessages">,
        citationId: citation.id,
      })
    },
    [activeChatId, showSource]
  )

  /** Opens the side chat, quoting a passage from the lesson when one was picked. */
  const openSideChat = useCallback((passage?: LessonPassage) => {
    if (passage) setQuote({ ...passage, id: createClientMessageId() })
    setSideChatOpen(true)
    setSideTab("chat")
  }, [])

  /** Closes the side chat, leaving an open source showing. */
  const closeSideChat = useCallback(() => {
    setSideChatOpen(false)
    setQuote(undefined)
    setSideTab("source")
  }, [])

  /** Closes whichever side panel tab is showing, revealing the other if there is one. */
  const closeSideTab = useCallback(() => {
    if (source && sideTab === "source") {
      setSource(undefined)
      setSideTab("chat")
    } else closeSideChat()
  }, [closeSideChat, sideTab, source])

  /** Closes the whole side panel, as dismissing it on a phone does. */
  const closeSidePanel = useCallback(() => {
    setSource(undefined)
    setSideChatOpen(false)
    setQuote(undefined)
  }, [])

  const clearQuote = useCallback(() => setQuote(undefined), [])

  /** Remembers a new side chat on this session, so it reopens with the lesson. */
  const rememberSideChat = useCallback(
    (sideChatId: Id<"workspaceChats">) => {
      if (!activeChatId) return
      void setTeachSideChat({ chatId: activeChatId, sideChatId }).catch(
        (failure: unknown) =>
          console.warn("Could not save the side chat", {
            message: failure instanceof Error ? failure.message : "Unknown error",
          })
      )
    },
    [activeChatId, setTeachSideChat]
  )

  // Answers draw on the section the question is about: the quoted passage's
  // section, otherwise the latest one.
  const askedReply = quote
    ? messages.find((message) => message.id === quote.messageId)
    : messages.findLast((message) => message.role === "assistant")
  const askedSection = useMemo(() => {
    if (!askedReply) return undefined
    const marker = parseTeachSectionMarker(askedReply.content)
    const title =
      marker?.kind === "section"
        ? outline?.sections.find((section) => section.id === marker.id)?.title
        : undefined
    const text = stripTeachMarkers(askedReply.content)
      .trim()
      .slice(0, MAX_LESSON_SECTION_CHARACTERS)
    return text ? { title: title ?? unit.title, text } : undefined
  }, [askedReply, outline, unit.title])

  // A voice lesson. The tutor reads the lesson aloud as it writes it, and "next" moves on. Anything
  // else the learner says goes to the side chat, so the lesson holds only lesson content; its answer
  // is read, then the lesson carries on from the sentence it was stopped at.
  const [voiceAsk, setVoiceAsk] = useState<VoiceAsk | null>(null)
  /** The learner said "next" while this message was the latest; nothing is read until a newer one. */
  const [nextFrom, setNextFrom] = useState<string | null>(null)
  const nextHeld = nextFrom !== null && lastMessage?.id === nextFrom
  /** The "next" already sent, so it goes once. */
  const nextSent = useRef<string | null>(null)
  const askCount = useRef(0)
  /** The side chat had been open before voice asked something, so it stays open afterwards. */
  const keepSideChat = useRef(false)
  // The answer is read from the saved side chat, so it carries on if the panel is closed meanwhile.
  const sideChat = useQuery(
    api.workspaceChats.get,
    voiceAsk?.before && chat?.teachSideChatId ? { chatId: chat.teachSideChatId } : "skip"
  )
  const sideAnswer = voiceAsk?.before
    ? sideChat?.messages.find((message) => message.role === "assistant" && !voiceAsk.before?.includes(message.id))
    : undefined
  const lessonReply: VoiceReply =
    lastMessage?.role === "assistant"
      ? { id: lastMessage.id, text: spokenReplyText(lastMessage.content, outline), complete: lastMessage.status !== "running" }
      : null
  const voice = useVoiceSession({
    busy: false,
    readOnStart: true,
    onTurn: async (text, cut) => {
      if (text === TEACH_QUICK_REPLIES.next || /^(next|next section|go on|continue|carry on)[.!?]?$/i.test(text.trim())) {
        setVoiceAsk(null); setNextFrom(lastMessage?.id ?? "")
        return
      }
      if (!voiceAsk) keepSideChat.current = sideChatOpen
      const note = !cut?.heard ? "" : voiceAsk
        ? voiceCutNote(cut)
        : `The learner paused the lesson being read aloud to ask this, just after hearing: "${cut.heard.slice(-1500)}".`
      setVoiceAsk({ id: ++askCount.current, text, note })
      openSideChat()
    },
    // After "next", nothing is read until the next section starts.
    reply: nextHeld
      ? null
      : voiceAsk
        ? sideAnswer ? { id: sideAnswer.id, text: sideAnswer.content, complete: sideAnswer.status !== "running" } : null
        : lessonReply,
    onReplyDone: (id) => {
      if (!voiceAsk || id !== sideAnswer?.id) return
      // The answer has been read: back to the lesson. A phone's full-screen side chat closes so the
      // lesson shows again, unless the learner had it open already.
      setVoiceAsk(null)
      if (!keepSideChat.current && !window.matchMedia("(min-width: 1024px)").matches) closeSidePanel()
    },
  })
  /** The side chat sent the question, or couldn't, in which case the lesson carries on. */
  const report = voice.report
  const currentAsk = useRef(voiceAsk)
  // A layout effect, so it is current before the side chat's own effect sends the ask and reports back.
  useLayoutEffect(() => { currentAsk.current = voiceAsk })
  const onAsked = useCallback((id: number, sent: boolean, before?: string[]) => {
    // A send settles only when its reply stream ends, by which time the answer may have been read.
    if (currentAsk.current?.id !== id) return
    setVoiceAsk((ask) => (ask?.id !== id ? ask : sent ? { ...ask, before: before ?? [] } : null))
    if (!sent) report("Your question didn't reach the side chat. Ask it again.")
  }, [report])
  const voiceOn = voice.phase !== "off"
  const replyReader = useReplyReader(readReplies && !voiceOn, messages, outline)
  const say = voice.say
  const nextByVoice = useCallback(() => say(TEACH_QUICK_REPLIES.next), [say])
  const voiceBar = (
    <VoiceBar
      session={voice}
      hint={'Questions go to the side chat. Say "next" for the next section.'}
      onNext={activeChatId ? nextByVoice : undefined}
    />
  )
  // While the side chat shows, the bar sits under it, beside the conversation it is having.
  const voiceBarInChat = voiceOn && sideChatOpen && (!source || sideTab === "chat")
  // "Next" goes to the tutor once the section being written has finished.
  useEffect(() => {
    if (!nextHeld || !voiceOn || running || sending || nextSent.current === nextFrom) return
    nextSent.current = nextFrom
    void send(TEACH_QUICK_REPLIES.next, undefined, true)
      .then((sent) => {
        if (sent) return
        // Saying "next" again retries it; the dock that shows send errors is hidden during voice.
        nextSent.current = null
        report("The next section didn't start. Say next again.")
      })
      .finally(() => setNextFrom(null))
  }, [nextHeld, nextFrom, voiceOn, running, sending, send, report])
  /** Starts voice afresh, without a question or "next" left from an earlier session. */
  const startVoice = voice.start
  const voiceStarter = useMemo(
    () => ({ ...voice, start: () => { setVoiceAsk(null); setNextFrom(null); startVoice() } }),
    [voice, startVoice]
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
  const hasMaterial = hasReadableMaterial
  const dockState: TeachDockState = !chat
    ? { kind: "starting" }
    : !hasMaterial && !messages.length
      ? { kind: "no-material" }
      : running
        ? { kind: outline ? "writing" : "starting" }
        : compacting
          ? { kind: "compacting" }
        : updating
          ? { kind: "updating" }
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

  const sideOpen = sideChatOpen || Boolean(source)

  const outlineList = outline ? (
    <TeachOutlineList
      outline={outline}
      sectionIndex={sectionIndex}
      taughtSectionIds={taughtSectionIds}
      plan={plan}
      pending={pendingSections}
      busy={running || updating}
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
          // An open side panel needs the room on mid-size screens; the header still shows progress.
          sideOpen ? "2xl:flex" : "lg:flex"
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
                      showSource({
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
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Button
              asChild
              variant="ghost"
              size="icon"
              className={cn("size-10 shrink-0", sideOpen ? "2xl:hidden" : "lg:hidden")}
            >
              <Link
                href={projectHref}
                aria-label={`Back to ${unit.projectTitle}`}
              >
                <ArrowLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 truncate font-heading text-lg font-semibold">
                {voiceOn ? (
                  <span
                    className="size-2 shrink-0 rounded-full bg-destructive motion-safe:animate-pulse"
                    aria-label="Voice lesson on"
                  />
                ) : null}
                <span className="truncate">{unit.title}</span>
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
                className="shrink-0 rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand tabular-nums"
                aria-label={`${sitting.xp} XP earned this session`}
              >
                +{sitting.xp} XP
              </p>
            ) : null}
            {chat && !voiceOn ? (
              <TalkButton
                session={voiceStarter}
                disabled={!activeChatId}
                className="h-10 min-h-10 max-sm:w-10 max-sm:px-0"
              >
                {/* On a phone the icon alone leaves the unit title room. */}
                <span className="max-sm:sr-only">Voice</span>
              </TalkButton>
            ) : null}
            {chat ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-10 shrink-0 rounded-full",
                  sideChatOpen ? "text-brand" : "text-muted-foreground"
                )}
                aria-label="Ask Blitz"
                aria-expanded={sideChatOpen}
                title="Ask Blitz"
                onClick={() => (sideChatOpen ? closeSideChat() : openSideChat())}
              >
                <BlitzLogo size={17} mono />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={unitOptionsRef}
                  variant="ghost"
                  size="icon"
                  className="size-10 shrink-0 rounded-full"
                  aria-label="Unit options"
                >
                  ⋯
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-60">
                {dockState.kind === "writing" ? (
                  <DropdownMenuItem
                    onSelect={() => void pause()}
                    className="min-h-11"
                  >
                    Pause writing
                  </DropdownMenuItem>
                ) : null}
                {features.contextUsage && chat?.contextUsage ? (
                  <DropdownMenuItem
                    onSelect={() => setContextOpen(true)}
                    className="group min-h-11"
                  >
                    Session context
                    <TeachContextMeter usage={chat.contextUsage} compacting={compacting} />
                  </DropdownMenuItem>
                ) : null}
                {chat ? (
                  <ReadRepliesToggle
                    enabled={readReplies}
                    onChange={setReadReplies}
                    reader={replyReader}
                  />
                ) : null}
                {chat && messages.length ? (
                  <DropdownMenuItem
                    onSelect={() => setSummaryOpen(true)}
                    className="min-h-11"
                  >
                    Finish for now
                  </DropdownMenuItem>
                ) : null}
                {chat ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  className="min-h-11"
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
                className={cn("mt-3", sideOpen ? "hidden 2xl:flex" : "hidden lg:flex")}
              />
              {/* Narrow screens have no rail, so the progress bar opens the outline. */}
              <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${progressLabel}. Show outline`}
                    className={cn(
                      "mt-2 flex min-h-8 w-full items-center gap-2 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      sideOpen ? "2xl:hidden" : "lg:hidden"
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
          {lessonUpdate ? (
            <TeachUpdateNotice
              className="mt-3"
              newFileCount={lessonUpdate.newSources.length}
              runningFileCount={lessonUpdate.run?.sourceCount ?? 0}
              running={updating}
              error={
                updateStartError ??
                (lessonUpdate.run?.status === "failed" ? lessonUpdate.run.error : null)
              }
              blocked={running || compacting}
              starting={startingUpdate}
              onUpdate={() => void updateLesson()}
            />
          ) : null}
        </header>

        <div className="relative min-h-0 flex-1">
          {/* `relative` contains KaTeX's absolutely positioned accessible copies. */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={cn(
              "relative h-full overflow-y-auto transition-opacity duration-300",
              // While the learner talks, the lesson steps back so the caption is the focus.
              (voice.phase === "hearing" || voice.phase === "thinking") && "opacity-55"
            )}
          >
            <div
              ref={columnRef}
              className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6"
            >
              {chat ? (
                <TeachLesson
                  messages={messages}
                  outline={outline}
                  unitTitle={unit.title}
                  answered={answered}
                  onCitation={openCitation}
                  onQuizAnswer={answerQuiz}
                  onFollowUp={(text) => void send(text)}
                  busy={running || compacting || updating}
                  sourceOpen={sideOpen}
                  compactions={chat.contextCompactions}
                  updates={lessonUpdates}
                  replyMarkers={replyMarkers}
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
          {chat ? (
            <TeachAskOverlay
              scrollRef={scrollRef}
              columnRef={columnRef}
              heldRange={quote?.range}
              onAsk={openSideChat}
            />
          ) : null}
        </div>

        {dockState.kind === "paused" &&
        chat?.lastErrorReason === "usage-limit" &&
        lastMessage?.role === "assistant" ? (
          <div className="px-4 sm:px-6">
            <ProviderHandoffOffer
              chatId={chat.id}
              messageId={lastMessage.id}
              providerId={chat.providerId}
              disabled={sending}
              onContinue={async () => { await send("", lastMessage.id) }}
            />
          </div>
        ) : null}
        {(voiceOn && !voiceBarInChat) || voice.error ? (
          // The same width and padding as the lesson column, like the dock it replaces.
          <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            <VoiceError session={voice} />
            {voiceOn && !voiceBarInChat ? voiceBar : null}
          </div>
        ) : null}
        {voiceOn ? null : (
          <TeachDock
            state={dockState}
            error={error}
            onSend={(message) => void send(message)}
            onResume={() =>
              lastMessage?.role === "assistant"
                ? void send("", lastMessage.id)
                : undefined
            }
          />
        )}
      </div>

      {sideOpen ? (
        <div className="contents lg:block lg:h-full lg:w-[min(42vw,620px)] lg:min-w-96 lg:shrink-0">
          <LearningSidePane
            sourceSelection={source}
            chatOpen={sideChatOpen}
            chatLesson={{
              projectId: unit.projectId,
              ...(quote
                ? {
                    quote: {
                      id: quote.id,
                      messageId: quote.messageId,
                      text: quote.text,
                    },
                  }
                : {}),
              ...(askedSection ? { section: askedSection } : {}),
              onQuoteCleared: clearQuote,
              onChatStarted: rememberSideChat,
              ...(voiceOn
                ? {
                    voice: {
                      ask: voiceAsk && !voiceAsk.before ? { id: voiceAsk.id, text: voiceAsk.text, note: voiceAsk.note } : null,
                      onAsked,
                      bar: voiceBarInChat ? voiceBar : null,
                    },
                  }
                : {}),
            }}
            lessonChatId={chat?.teachSideChatId ?? undefined}
            activeTab={source ? sideTab : "chat"}
            onTabChange={setSideTab}
            onCloseTab={closeSideTab}
            onClose={closeSidePanel}
            onOpenSource={showSource}
          />
        </div>
      ) : null}

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          onCloseAutoFocus={focusUnitOptions}
        >
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

      {features.contextUsage && chat?.contextUsage ? (
        <TeachContextDetails
          open={contextOpen}
          onOpenChange={setContextOpen}
          onCloseAutoFocus={focusUnitOptions}
          usage={chat.contextUsage}
          compacting={compacting}
          canCompact={features.compact && !running}
          onCompact={() => void compactNow()}
          error={compactError}
        />
      ) : null}

      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent onCloseAutoFocus={focusUnitOptions}>
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
