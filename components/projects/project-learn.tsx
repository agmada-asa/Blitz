"use client"

/** Owns the focused project Learn flow and its persisted answer and exposure behavior. */

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Markdown } from "@/components/ui/markdown"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  FileIcon,
} from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {
  AnswerRequest,
  AnswerResponse,
  EventRequest,
  LearningAnswer,
} from "@/lib/learning/client-contracts"
import { ReadAloudButton } from "@/components/chat/read-aloud-button"
import {
  LearningSidePane,
  type LearningChatCard,
  type LearningPanelSelection,
  type LearningSidePaneTab,
} from "@/components/projects/learning-side-pane"
import {
  type LearningSourceSelection,
} from "@/components/chat/source-pane"
import { cn } from "@/lib/utils"

/** Describes the source-grounded path returned by the project learning query. */
type ProjectPath = FunctionReturnType<typeof api.learning.getProjectPath>

/** Describes one section in the project learning path. */
type LearnSection = ProjectPath["sections"][number]

/** Describes one concept and its cards in the project learning path. */
type LearnConcept = LearnSection["concepts"][number]

/** Describes one explanation or answerable check shown in Learn. */
type LearnItem = LearnConcept["items"][number]

/** Builds the visible lesson or question copy that read aloud should speak. */
function learnItemSpeechText(item: LearnItem): string {
  if (item.type === "explain")
    return [item.title, item.body]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n")

  const options =
    item.type === "true-false"
      ? [{ text: "True" }, { text: "False" }]
      : (item.options ?? [])
  return [
    item.question || item.title,
    ...options.map(
      (option, index) => `${String.fromCharCode(65 + index)}. ${option.text}`
    ),
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n")
}

/** Props identify the project whose path and learning events are displayed. */
type ProjectLearnProps = {
  projectId: string
  resume?: boolean
}

/** Identifies the remembered location for the user's current learning session. */
type SavedLocation = {
  sectionId: string
  conceptId: string
  itemId: string
}

/** Creates a unique browser event id accepted by the learning API. */
function createClientEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads a safe server error string and falls back when its response is invalid. */
async function readApiError(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error
    }
  } catch {
    // A malformed response uses the caller's concise recovery message.
  }
  return fallback
}

/** Sends one answer for server evaluation and returns source-safe feedback. */
async function submitAnswer(request: AnswerRequest): Promise<AnswerResponse> {
  const response = await fetch("/api/learning/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    throw new Error(
      await readApiError(response, "Could not check that answer.")
    )
  }
  return (await response.json()) as AnswerResponse
}

/** Records passive exposure without interrupting a learner when it fails. */
async function recordExposure(request: EventRequest): Promise<void> {
  await fetch("/api/learning/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }).catch(() => undefined)
}

/** Returns the browser storage key scoped to one project. */
function storageKey(projectId: string): string {
  return `blitz:learn:${projectId}`
}

/** Parses a stored location and ignores incomplete or malformed values. */
function parseSavedLocation(value: string | null): SavedLocation | null {
  try {
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<SavedLocation>
    if (
      typeof parsed.sectionId !== "string" ||
      typeof parsed.conceptId !== "string" ||
      typeof parsed.itemId !== "string"
    ) {
      return null
    }
    return {
      sectionId: parsed.sectionId,
      conceptId: parsed.conceptId,
      itemId: parsed.itemId,
    }
  } catch {
    return null
  }
}

/** Subscribes to saved-location changes from another tab or this Learn route. */
function subscribeToSavedLocation(onStoreChange: () => void): () => void {
  const notify = () => onStoreChange()
  window.addEventListener("storage", notify)
  window.addEventListener("blitz:learn-location", notify)
  return () => {
    window.removeEventListener("storage", notify)
    window.removeEventListener("blitz:learn-location", notify)
  }
}

/** Reads saved progress through React's hydration-safe external-store API. */
function useSavedLocation(projectId: string): SavedLocation | null {
  const savedValue = useSyncExternalStore(
    subscribeToSavedLocation,
    () => {
      try {
        return window.localStorage.getItem(storageKey(projectId))
      } catch {
        return null
      }
    },
    () => null
  )
  return useMemo(() => parseSavedLocation(savedValue), [savedValue])
}

/** Captures query errors and offers a readable recovery screen for Learn. */
class LearningErrorBoundary extends Component<
  { children: ReactNode; projectId: string },
  { hasError: boolean }
> {
  /** Initializes the boundary in its normal rendering state. */
  constructor(props: { children: ReactNode; projectId: string }) {
    super(props)
    this.state = { hasError: false }
  }

  /** Switches to the recovery screen after any descendant render error. */
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  /** Renders either the Learn page or a route-specific query recovery state. */
  render() {
    if (this.state.hasError) {
      return (
        <main className="mx-auto max-w-2xl px-4 py-12 sm:px-8">
          <h1 className="font-heading text-3xl font-medium">
            Learn is unavailable
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The learning path could not be loaded. Try again or return to the
            project.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              onClick={() => window.location.reload()}
              className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              Try again
            </Button>
            <Button
              asChild
              variant="outline"
              className="min-h-11 rounded-full px-5"
            >
              <Link
                href={`/projects/${encodeURIComponent(this.props.projectId)}`}
              >
                Back to project
              </Link>
            </Button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

/** Wraps Convex-backed Learn content in a route-local query error boundary. */
export function ProjectLearn({ projectId, resume = false }: ProjectLearnProps) {
  return (
    <LearningErrorBoundary projectId={projectId}>
      <ProjectLearnContent projectId={projectId} resume={resume} />
    </LearningErrorBoundary>
  )
}

/** Loads a project path and renders navigation, lesson content, and answer states. */
function ProjectLearnContent({ projectId, resume = false }: ProjectLearnProps) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const path = useQuery(
    api.learning.getProjectPath,
    project ? { projectId: convexProjectId } : "skip"
  )
  const [selectedSectionId, setSelectedSectionId] = useState<string>()
  const [selectedConceptId, setSelectedConceptId] = useState<string>()
  const [itemIndex, setItemIndex] = useState<number>()
  const [sessionStarted, setSessionStarted] = useState(resume)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sourceSelection, setSourceSelection] =
    useState<LearningPanelSelection>()
  const [askBlitzOpen, setAskBlitzOpen] = useState(false)
  const [chatCard, setChatCard] = useState<LearningChatCard>()
  const [sidePaneTab, setSidePaneTab] =
    useState<LearningSidePaneTab>("source")
  const [sidePaneWidth, setSidePaneWidth] = useState(420)
  const [sidePaneMaxWidth, setSidePaneMaxWidth] = useState(720)
  const layoutRef = useRef<HTMLElement | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [feedback, setFeedback] = useState<AnswerResponse | null>(null)
  const [answerError, setAnswerError] = useState("")
  const [pending, setPending] = useState(false)
  const exposedItemIds = useRef(new Set<string>())
  const savedLocation = useSavedLocation(projectId)

  const defaultSection = useMemo(
    () =>
      path?.sections.find((section) =>
        section.concepts.some(
          (concept) => concept.completionStatus !== "completed"
        )
      ) ?? path?.sections[0],
    [path]
  )
  const activeSection =
    path?.sections.find((section) => section.id === selectedSectionId) ??
    path?.sections.find((section) => section.id === savedLocation?.sectionId) ??
    defaultSection
  const defaultConcept = useMemo(
    () =>
      activeSection?.concepts.find(
        (concept) => concept.completionStatus !== "completed"
      ) ?? activeSection?.concepts[0],
    [activeSection]
  )
  const activeConcept =
    activeSection?.concepts.find(
      (concept) => concept.id === selectedConceptId
    ) ??
    (activeSection &&
    savedLocation &&
    activeSection.id === savedLocation.sectionId
      ? activeSection.concepts.find(
          (concept) => concept.id === savedLocation.conceptId
        )
      : undefined) ??
    defaultConcept
  const items = activeConcept?.items ?? []
  const savedIndex =
    activeConcept &&
    savedLocation &&
    activeConcept.id === savedLocation.conceptId
      ? activeConcept.items.findIndex(
          (item) => item.id === savedLocation.itemId
        )
      : -1
  const activeItemIndex = itemIndex ?? (savedIndex >= 0 ? savedIndex : 0)
  const currentItem = items[activeItemIndex]
  const sourceCitations = currentItem?.sourceCitations?.length
    ? currentItem.sourceCitations
    : (activeConcept?.sourceCitations ?? [])
  const sidePaneOpen = Boolean(sourceSelection || askBlitzOpen)

  /** Returns the widest side panel that leaves room for the lesson column. */
  const maximumSidePaneWidth = useCallback((): number => {
    const layoutWidth =
      layoutRef.current?.getBoundingClientRect().width ??
      (typeof window === "undefined" ? 1024 : window.innerWidth)
    return Math.max(320, Math.min(720, Math.floor(layoutWidth - 230 - 240 - 8)))
  }, [])

  /** Keeps a requested panel width within the learning layout's usable range. */
  const fitSidePaneWidth = useCallback(
    (width: number): number =>
      Math.min(maximumSidePaneWidth(), Math.max(320, Math.round(width))),
    [maximumSidePaneWidth]
  )

  /** Opens one source in the shared side panel and makes its tab active. */
  function openSource(selection: LearningPanelSelection): void {
    setSourceSelection(selection)
    setSidePaneTab("source")
    setSidePaneWidth((width) => fitSidePaneWidth(width))
  }

  /** Starts Ask Blitz with the current learning card attached as context. */
  function openAskBlitz(): void {
    if (!currentItem) return
    const sourceLabel = Array.from(
      new Set(sourceCitations.map((citation) => citation.filename))
    )
      .slice(0, 3)
      .join(", ")
      .slice(0, 180)
    setChatCard({
      id: currentItem.id as Id<"learningItems">,
      projectId: convexProjectId,
      title: currentItem.title,
      sourceLabel: sourceLabel || "Source unavailable",
    })
    setAskBlitzOpen(true)
    setSidePaneTab("chat")
    setSidePaneWidth((width) => fitSidePaneWidth(width))
  }

  /** Closes the active tab and selects another open tab when one remains. */
  function closeActiveSidePaneTab(): void {
    if (sidePaneTab === "source") {
      setSourceSelection(undefined)
      if (askBlitzOpen) setSidePaneTab("chat")
      return
    }
    setAskBlitzOpen(false)
    if (sourceSelection) setSidePaneTab("source")
  }

  /** Closes all side panel tabs after a mobile dialog dismissal. */
  function closeSidePane(): void {
    setSourceSelection(undefined)
    setAskBlitzOpen(false)
  }

  /** Sets the panel width from the left edge of its right-anchored track. */
  function resizeSidePane(clientX: number): void {
    const bounds = layoutRef.current?.getBoundingClientRect()
    if (!bounds) return
    setSidePaneWidth(fitSidePaneWidth(bounds.right - clientX))
  }

  /** Re-clamps the panel if the app shell or browser viewport changes width. */
  useEffect(() => {
    if (!sidePaneOpen || !layoutRef.current) return
    const clampOnResize = () => {
      const maximum = maximumSidePaneWidth()
      setSidePaneMaxWidth(maximum)
      setSidePaneWidth((width) => fitSidePaneWidth(width))
    }
    clampOnResize()
    const observer = new ResizeObserver(clampOnResize)
    observer.observe(layoutRef.current)
    window.addEventListener("resize", clampOnResize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", clampOnResize)
    }
  }, [fitSidePaneWidth, maximumSidePaneWidth, sidePaneOpen])

  /** Persists the active item so the project can resume this lesson later. */
  useEffect(() => {
    if (!sessionStarted || !activeSection || !activeConcept || !currentItem)
      return
    try {
      window.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({
          sectionId: activeSection.id,
          conceptId: activeConcept.id,
          itemId: currentItem.id,
        } satisfies SavedLocation)
      )
      window.dispatchEvent(new Event("blitz:learn-location"))
    } catch {
      // Storage may be disabled; in-memory navigation remains available.
    }
  }, [activeConcept, activeSection, currentItem, projectId, sessionStarted])

  /** Records the current card's passive exposure once per mounted route. */
  useEffect(() => {
    if (
      !sessionStarted ||
      !currentItem ||
      exposedItemIds.current.has(currentItem.id)
    )
      return
    exposedItemIds.current.add(currentItem.id)
    void recordExposure({
      projectId,
      itemId: currentItem.id,
      clientEventId: createClientEventId(),
      occurredAt: Date.now(),
      eventType: "exposure",
    })
  }, [currentItem, projectId, sessionStarted])

  /** Clears a previous answer result whenever the learner changes cards. */
  const resetAnswer = useCallback(() => {
    setSelection([])
    setFeedback(null)
    setAnswerError("")
  }, [])

  /** Opens the next available lesson in a section, restoring its saved card. */
  function selectSection(section: LearnSection): void {
    const nextConcept =
      section.concepts.find(
        (concept) =>
          concept.completionStatus !== "completed" && concept.items.length
      ) ?? section.concepts.find((concept) => concept.items.length)
    const savedItemIndex =
      nextConcept &&
      savedLocation?.sectionId === section.id &&
      savedLocation.conceptId === nextConcept.id
        ? nextConcept.items.findIndex(
            (item) => item.id === savedLocation.itemId
          )
        : -1
    setSelectedSectionId(section.id)
    setSelectedConceptId(nextConcept?.id)
    setItemIndex(savedItemIndex >= 0 ? savedItemIndex : 0)
    setSessionStarted(Boolean(nextConcept))
    setMobileNavOpen(false)
    resetAnswer()
  }

  /** Opens the selected concept at its first card. */
  function startConcept(concept: LearnConcept): void {
    setSelectedConceptId(concept.id)
    setItemIndex(
      activeSection &&
        savedLocation &&
        activeSection.id === savedLocation.sectionId &&
        concept.id === savedLocation.conceptId &&
        savedIndex >= 0
        ? savedIndex
        : 0
    )
    setSessionStarted(true)
    setMobileNavOpen(false)
    resetAnswer()
  }

  /** Advances to the next card, or to the next concept when this one ends. */
  function advance(): void {
    if (pending) return
    if (activeItemIndex < items.length - 1) {
      setItemIndex(activeItemIndex + 1)
      resetAnswer()
      return
    }
    if (!activeConcept) {
      setSessionStarted(false)
      return
    }
    const conceptPosition = orderedLessons.findIndex(
      ({ concept }) => concept.id === activeConcept.id
    )
    const next = orderedLessons[conceptPosition + 1]
    if (next) {
      setSelectedSectionId(next.section.id)
      setSelectedConceptId(next.concept.id)
      setItemIndex(0)
      resetAnswer()
      return
    }
    setSessionStarted(false)
  }

  /** Returns to the previous card, crossing into the preceding lesson if needed. */
  function retreat(): void {
    if (pending || !activeConcept) return
    if (activeItemIndex > 0) {
      setItemIndex(activeItemIndex - 1)
      resetAnswer()
      return
    }
    const conceptPosition = orderedLessons.findIndex(
      ({ concept }) => concept.id === activeConcept.id
    )
    const previous = orderedLessons[conceptPosition - 1]
    if (!previous) return
    setSelectedSectionId(previous.section.id)
    setSelectedConceptId(previous.concept.id)
    setItemIndex(previous.concept.items.length - 1)
    resetAnswer()
  }

  /** Toggles a multiple-answer choice while keeping answer order stable. */
  function toggleSelection(optionId: string): void {
    setSelection((current) =>
      current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
    )
  }

  /** Scores the current selection and keeps it retryable if the request fails. */
  async function checkAnswer(answer: LearningAnswer): Promise<void> {
    if (!currentItem || pending || feedback) return
    setPending(true)
    setAnswerError("")
    const request: AnswerRequest = {
      projectId,
      itemId: currentItem.id,
      clientEventId: createClientEventId(),
      occurredAt: Date.now(),
      answer,
    }
    try {
      const result = await submitAnswer(request)
      if (result.status === "invalid") {
        setAnswerError("That answer could not be checked. Try again.")
        return
      }
      setFeedback(result)
    } catch (reason) {
      setAnswerError(
        reason instanceof Error
          ? reason.message
          : "Could not check that answer."
      )
    } finally {
      setPending(false)
    }
  }

  /** Builds option buttons and highlights only feedback returned by the server. */
  function renderOptions(item: LearnItem) {
    const isMultiple = item.type === "multiple-answer"
    const options =
      item.type === "true-false"
        ? [
            { id: "true", text: "True" },
            { id: "false", text: "False" },
          ]
        : (item.options ?? [])
    return (
      <div
        className="mt-5 space-y-2"
        role={isMultiple ? "group" : "radiogroup"}
        aria-label={isMultiple ? "Select all that apply" : "Answer options"}
        aria-busy={pending}
      >
        {options.map((option, index) => {
          const selected = selection.includes(option.id)
          const correct = Boolean(
            feedback?.feedback &&
            (item.type === "true-false"
              ? feedback.feedback.correctAnswer === (option.id === "true")
              : item.type === "single-choice"
                ? feedback.feedback.correctOptionId === option.id
                : feedback.feedback.correctOptionIds?.includes(option.id))
          )
          const incorrectSelection = Boolean(feedback && selected && !correct)
          return (
            <button
              key={option.id}
              type="button"
              role={isMultiple ? "checkbox" : "radio"}
              aria-checked={selected}
              disabled={pending || feedback !== null}
              onClick={() =>
                isMultiple
                  ? toggleSelection(option.id)
                  : setSelection([option.id])
              }
              className={cn(
                "flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl border bg-card px-3 py-3 text-left text-sm transition-colors hover:border-brand/50 hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default sm:px-4 sm:text-base",
                selected && !feedback && "border-brand/60 bg-brand/15 hover:border-brand/70 hover:bg-brand/20",
                correct && "border-emerald-500/45 bg-emerald-500/[0.06]",
                incorrectSelection &&
                  "border-destructive/45 bg-destructive/[0.06]"
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">
                {correct ? (
                  <CheckIcon size={15} aria-hidden="true" />
                ) : (
                  String.fromCharCode(65 + index)
                )}
              </span>
              <span className="flex-1 leading-5">{option.text}</span>
            </button>
          )
        })}
      </div>
    )
  }

  /** Renders accessible section and concept navigation for desktop and mobile. */
  function renderNavigation() {
    if (!path || !activeSection) return null
    return (
      <nav aria-label="Learning path" className="space-y-1">
        {path.sections.map((section) => {
          const sectionActive = activeSection.id === section.id
          return (
            <div key={section.id}>
              <button
                type="button"
                aria-current={sectionActive ? "location" : undefined}
                onClick={() => selectSection(section)}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  sectionActive && "bg-muted"
                )}
              >
                <span className="min-w-0 truncate">{section.title}</span>
                <span className="text-xs text-muted-foreground">
                  {section.concepts.length}
                </span>
              </button>
              {sectionActive && sessionStarted ? (
                <div className="ml-3 border-l border-border/70 pl-2">
                  {section.concepts.map((concept) => (
                    <button
                      key={concept.id}
                      type="button"
                      aria-label={
                        concept.questionCount > 0
                          ? concept.title +
                            ", " +
                            concept.answeredQuestionCount +
                            " of " +
                            concept.questionCount +
                            " questions answered"
                          : concept.title + ", no questions"
                      }
                      aria-current={
                        activeConcept?.id === concept.id && sessionStarted
                          ? "page"
                          : undefined
                      }
                      onClick={() => startConcept(concept)}
                      className={cn(
                        "flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        activeConcept?.id === concept.id &&
                          "font-medium text-foreground",
                        concept.completionStatus === "completed" &&
                          "text-emerald-700 dark:text-emerald-300"
                      )}
                    >
                      {concept.completionStatus === "completed" ? (
                        <CheckCircleIcon
                          size={15}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-current"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{concept.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {concept.questionCount > 0
                          ? concept.answeredQuestionCount +
                            "/" +
                            concept.questionCount
                          : "No questions"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </nav>
    )
  }

  if (project === undefined || path === undefined) {
    return (
      <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-10">
        <div
          className="hidden space-y-2 lg:block"
          aria-label="Loading learning path"
        >
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-12 w-4/5" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-11 w-36 rounded-full" />
        </div>
      </main>
    )
  }

  if (!project) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-8">
        <h1 className="font-heading text-3xl font-medium">Project not found</h1>
        <Button
          asChild
          variant="outline"
          className="mt-6 min-h-11 rounded-full px-5"
        >
          <Link href="/">Back to projects</Link>
        </Button>
      </main>
    )
  }

  if (!path.sections.length || !activeSection || !activeConcept) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8 sm:py-12">
        <ProjectHeading projectTitle={project.title} projectId={projectId} />
        <h1 className="mt-10 font-heading text-3xl font-medium">
          No learning material yet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Add a source to this project to build a learning path.
        </p>
        <Button
          asChild
          variant="outline"
          className="mt-6 min-h-11 rounded-full px-5"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>
            Back to project
          </Link>
        </Button>
      </main>
    )
  }

  /** Opens or closes the compact section and concept navigation on mobile. */
  function showMobileNavigation(): void {
    setMobileNavOpen((open) => !open)
  }
  const isQuestion = currentItem ? currentItem.type !== "explain" : false
  const isMultiple = currentItem?.type === "multiple-answer"
  const questionAnswer: LearningAnswer | undefined = currentItem
    ? currentItem.type === "true-false"
      ? selection[0] === "true"
      : isMultiple
        ? selection
        : selection[0]
    : undefined
  const orderedLessons =
    path?.sections.flatMap((section) =>
      section.concepts
        .filter((concept) => concept.items.length)
        .map((concept) => ({ section, concept }))
    ) ?? []
  const activeLessonPosition = orderedLessons.findIndex(
    ({ concept }) => concept.id === activeConcept.id
  )
  const hasPreviousCard = activeItemIndex > 0 || activeLessonPosition > 0
  const hasNextCard =
    activeItemIndex < items.length - 1 ||
    activeLessonPosition < orderedLessons.length - 1
  const isLastConcept = activeLessonPosition === orderedLessons.length - 1
  const continueLabel =
    activeItemIndex < items.length - 1
      ? "Continue"
      : isLastConcept
        ? "Learning path"
        : "Next concept"

  return (
    <main
      ref={layoutRef}
      style={
        { "--learning-side-pane-width": `${sidePaneWidth}px` } as CSSProperties
      }
      className={cn(
        "relative grid min-h-[calc(100svh-68px-env(safe-area-inset-bottom))] w-full grid-cols-1 pb-5 lg:h-svh lg:min-h-0 lg:overflow-hidden lg:pb-0",
        sidePaneOpen
          ? "lg:grid-cols-[230px_minmax(0,1fr)_8px_var(--learning-side-pane-width)]"
          : "lg:grid-cols-[230px_minmax(0,1fr)]"
      )}
    >
      <aside className="min-w-0 px-4 py-5 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden lg:border-r lg:border-border/70 lg:bg-background/70">
        <ProjectHeading projectTitle={project.title} projectId={projectId} />
        <div className="mt-5 lg:hidden">
          <Button
            type="button"
            variant="outline"
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-learning-navigation"
            onClick={showMobileNavigation}
            className="min-h-11 w-full justify-between rounded-xl"
          >
            <span>{sessionStarted ? activeConcept.title : "Sections"}</span>
            <span aria-hidden="true">{mobileNavOpen ? "−" : "+"}</span>
          </Button>
          {mobileNavOpen ? (
            <div
              id="mobile-learning-navigation"
              className="mt-2 max-h-[45svh] overflow-y-auto rounded-xl border border-border/70 bg-card p-2"
            >
              {renderNavigation()}
            </div>
          ) : null}
        </div>
        <div className="mt-6 hidden min-h-0 flex-1 overflow-y-auto lg:block">
          {renderNavigation()}
        </div>
      </aside>

      <section className="min-w-0 px-4 py-5 sm:px-7 sm:py-8 lg:min-h-0 lg:overflow-y-auto lg:px-0 lg:py-8">
        {!sessionStarted ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
                {activeSection.title}
              </h2>
            </div>
            <ul className="mt-6 divide-y divide-border/60 border-y border-border/60">
              {activeSection.concepts.map((concept) => (
                <li key={concept.id}>
                  <button
                    type="button"
                    aria-label={
                      concept.questionCount > 0
                        ? concept.title +
                          ", " +
                          concept.answeredQuestionCount +
                          " of " +
                          concept.questionCount +
                          " questions answered"
                        : concept.title + ", no questions"
                    }
                    aria-current={
                      activeConcept.id === concept.id ? "step" : undefined
                    }
                    onClick={() => startConcept(concept)}
                    disabled={!concept.items.length}
                    className={cn(
                      "flex min-h-14 w-full items-center gap-3 py-3 text-left text-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      activeConcept.id === concept.id
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {concept.completionStatus === "completed" ? (
                      <CheckCircleIcon
                        size={17}
                        className="shrink-0 text-emerald-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="flex size-[17px] shrink-0 items-center justify-center rounded-full border border-border text-[10px]">
                        {activeSection.concepts.indexOf(concept) + 1}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">{concept.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {concept.questionCount > 0
                        ? concept.answeredQuestionCount +
                          " / " +
                          concept.questionCount +
                          " questions"
                        : "No questions"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              disabled={!activeConcept.items.length}
              onClick={() => startConcept(activeConcept)}
              className="mt-6 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              Resume learning <ArrowRightIcon aria-hidden="true" />
            </Button>
          </>
        ) : currentItem ? (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSessionStarted(false)}
                className="min-h-10 rounded-full px-3"
              >
                <ArrowLeftIcon aria-hidden="true" /> Learning path
              </Button>
              <ReadAloudButton
                key={currentItem.id}
                text={learnItemSpeechText(currentItem)}
              />
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {activeItemIndex + 1} of {items.length}
                </span>
                <Progress
                  value={Math.round(
                    ((activeItemIndex + 1) / items.length) * 100
                  )}
                  className="h-1.5 w-16 sm:w-24"
                  aria-label={`Page ${activeItemIndex + 1} of ${items.length}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Previous page"
                  title="Previous page"
                  disabled={!hasPreviousCard || pending}
                  onClick={retreat}
                  className="min-h-10 min-w-10 rounded-full"
                >
                  <ArrowLeftIcon aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Next page"
                  title="Next page"
                  disabled={!hasNextCard || pending}
                  onClick={advance}
                  className="min-h-10 min-w-10 rounded-full"
                >
                  <ArrowRightIcon aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="mx-auto w-full max-w-4xl px-4 text-left sm:px-7">
            {isQuestion ? (
              <>
                <h2 className="max-w-3xl font-heading text-3xl font-medium tracking-tight sm:text-4xl">
                  {currentItem.question || currentItem.title}
                </h2>
                {renderOptions(currentItem)}
                {feedback ? (
                  <div
                    role="status"
                    className={cn(
                      "mt-5 rounded-xl border px-4 py-3",
                      feedback.isCorrect
                        ? "border-emerald-500/35 bg-emerald-500/[0.06]"
                        : "border-destructive/35 bg-destructive/[0.06]"
                    )}
                  >
                    <p className="font-medium">
                      {feedback.isCorrect ? "Correct" : "Not quite"}
                    </p>
                    {feedback.feedback?.body ? (
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {feedback.feedback.body}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {answerError ? (
                  <p role="alert" className="mt-4 text-sm text-destructive">
                    {answerError}
                  </p>
                ) : null}
                <SourceReferences
                  citations={sourceCitations}
                  projectId={convexProjectId}
                  onOpen={openSource}
                />
                {feedback ? (
                  <Button
                    type="button"
                    onClick={advance}
                    className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                  >
                    {continueLabel} <ArrowRightIcon aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={
                      !selection.length ||
                      pending ||
                      questionAnswer === undefined
                    }
                    onClick={() =>
                      questionAnswer !== undefined &&
                      void checkAnswer(questionAnswer)
                    }
                    className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                  >
                    {pending ? "Checking…" : "Check answer"}
                  </Button>
                )}
              </>
            ) : (
              <>
                <h2 className="max-w-3xl font-heading text-[clamp(2rem,6vw,4rem)] leading-[1.02] font-medium tracking-[-0.04em]">
                  {currentItem.title}
                </h2>
                {currentItem.body ? (
                  <div className="mt-5 max-w-[68ch] text-base leading-7 text-foreground/80 [&_.chat-markdown]:space-y-4">
                    <Markdown text={currentItem.body} />
                  </div>
                ) : null}
                {currentItem.deepExplanation ? (
                  <details className="group mt-5 max-w-[68ch]">
                    <summary className="w-fit cursor-pointer rounded-md text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      More detail
                    </summary>
                    <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
                      {currentItem.deepExplanation
                        .split(/\n{2,}/)
                        .map((paragraph, index) => (
                          <p key={`${currentItem.id}-detail-${index}`}>
                            {paragraph}
                          </p>
                        ))}
                    </div>
                  </details>
                ) : null}
                <SourceReferences
                  citations={sourceCitations}
                  projectId={convexProjectId}
                  onOpen={openSource}
                />
                <Button
                  type="button"
                  onClick={advance}
                  className="mt-7 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                >
                  {continueLabel} <ArrowRightIcon aria-hidden="true" />
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              className="mt-3 min-h-10 rounded-full px-3"
              onClick={openAskBlitz}
            >
              Ask Blitz
            </Button>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-border/70 bg-card p-5">
            <h1 className="font-heading text-2xl font-medium">
              This concept has no learning pages
            </h1>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSessionStarted(false)}
              className="mt-5 min-h-11 rounded-full px-5"
            >
              Back to learning path
            </Button>
          </div>
        )}
      </section>
      {sidePaneOpen ? (
        <>
          <button
            type="button"
            role="separator"
            aria-label="Resize learning side panel"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={sidePaneMaxWidth}
            aria-valuenow={sidePaneWidth}
            className="hidden touch-none cursor-col-resize items-center justify-center bg-transparent outline-none hover:bg-border/30 focus-visible:bg-border/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand lg:flex"
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeSidePane(event.clientX)
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                resizeSidePane(event.clientX)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 48 : 16
              if (event.key === "ArrowLeft") {
                event.preventDefault()
                setSidePaneWidth((width) => fitSidePaneWidth(width + step))
              } else if (event.key === "ArrowRight") {
                event.preventDefault()
                setSidePaneWidth((width) => fitSidePaneWidth(width - step))
              } else if (event.key === "Home") {
                event.preventDefault()
                setSidePaneWidth(320)
              } else if (event.key === "End") {
                event.preventDefault()
                setSidePaneWidth(sidePaneMaxWidth)
              }
            }}
          >
            <span aria-hidden="true" className="h-12 w-0.5 rounded-full bg-border" />
          </button>
          <LearningSidePane
            sourceSelection={sourceSelection}
            chatOpen={askBlitzOpen}
            chatCard={chatCard}
            activeTab={sidePaneTab}
            onTabChange={setSidePaneTab}
            onCloseTab={closeActiveSidePaneTab}
            onClose={closeSidePane}
            onOpenSource={openSource}
          />
        </>
      ) : null}
    </main>
  )
}

/** Renders the project label and return link shared by Learn states. */
function ProjectHeading({
  projectTitle,
  projectId,
}: {
  projectTitle: string
  projectId: string
}) {
  return (
    <div className="min-w-0">
      <Link
        href={`/projects/${encodeURIComponent(projectId)}`}
        className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-lg text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeftIcon size={16} aria-hidden="true" />
        <span className="truncate">{projectTitle}</span>
      </Link>
      <h1 className="mt-1 font-heading text-2xl font-medium">Learn</h1>
    </div>
  )
}

/** Lists source filenames associated with the current learning item. */
function SourceReferences({
  citations,
  projectId,
  onOpen,
}: {
  citations: Array<{ sourceId: string; filename: string; locator?: string }>
  projectId: Id<"projects">
  onOpen: (selection: LearningSourceSelection) => void
}) {
  if (!citations.length) return null
  return (
    <p className="mt-5 flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
      <FileIcon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-wrap gap-x-1">
        {citations.map((citation, index) => (
          <span key={`${citation.sourceId}:${citation.locator ?? index}`}>
            {index > 0 ? "· " : null}
            <button
              type="button"
              className="rounded-sm text-left underline decoration-border underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() =>
                onOpen({
                  kind: "learning",
                  projectId,
                  sourceId: citation.sourceId as Id<"sources">,
                  filename: citation.filename,
                  locator: citation.locator,
                })
              }
            >
              {citation.filename}{citation.locator ? `, ${citation.locator}` : ""}
            </button>
          </span>
        ))}
      </span>
    </p>
  )
}
