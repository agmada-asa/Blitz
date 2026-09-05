"use client"

/** Composes project sources, an automatic learning path, and the walkthrough stage. */

import Link from "next/link"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQuery } from "convex/react"

import { WalkthroughCard, type WalkthroughItem } from "./walkthrough-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CheckCircleIcon,
  FileIcon,
  HelpIcon,
  LayersIcon,
  SparklesIcon,
} from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** Source metadata shown in the compact project source rail. */
export type WorkspaceSource = {
  id: string
  filename: string
  status: "processing" | "ready" | "failed"
}

/** Props supplied by the project route around its existing management controls. */
type ProjectLearningWorkspaceProps = {
  projectId: Id<"projects">
  projectTitle: string
  sources: WorkspaceSource[]
  headerActions: ReactNode
  sourceManager: ReactNode
  onOpenSource?: (sourceId: string) => void
}

/** One flattened stage item with its parent concept label. */
type StageItem = WalkthroughItem & { conceptTitle: string }

/** Stores the current card for one walkthrough without mixing it into mastery. */
function storageKey(projectId: string, pathKey: string): string {
  return `blitz:walkthrough:${projectId}:${pathKey}`
}

/** Normalizes generated concept labels so a deep dive can span matching sections. */
function conceptKey(title: string): string {
  return title.trim().toLocaleLowerCase()
}

/** Returns whether browser motion settings require an instant jump. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Returns whether arrow keys belong to an open dialog or editable control. */
function shouldPreserveArrowKey(target: EventTarget | null): boolean {
  if (document.querySelector('[role="dialog"]')) return true
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]'
    )
  )
}

/** Finds the stage card whose centre is nearest the scroll viewport centre. */
function closestCardIndex(container: HTMLDivElement): number {
  const cards = Array.from(
    container.querySelectorAll<HTMLElement>("[data-walkthrough-card]")
  )
  if (!cards.length) return 0
  const viewportCenter = container.scrollTop + container.clientHeight / 2
  let closestIndex = 0
  let closestDistance = Number.POSITIVE_INFINITY
  cards.forEach((card, index) => {
    const cardCenter = card.offsetTop + card.offsetHeight / 2
    const distance = Math.abs(cardCenter - viewportCenter)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })
  return closestIndex
}

/** Records one passive walkthrough exposure without interrupting reading. */
async function recordWalkthroughExposure(
  projectId: string,
  itemId: string
): Promise<void> {
  const clientEventId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  await fetch("/api/learning/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      itemId,
      clientEventId,
      occurredAt: Date.now(),
      eventType: "exposure",
    }),
  }).catch(() => undefined)
}

/** Renders the automatic section list in desktop and compact dialogs. */
function LearningPathList({
  sections,
  activeSectionId,
  onSelect,
}: {
  sections: Array<{
    id: string
    title: string
    masteredConcepts: number
    hasNewMaterial: boolean
    concepts: Array<unknown>
  }>
  activeSectionId: string
  onSelect: (sectionId: string) => void
}) {
  return (
    <nav aria-label="Learning path" className="space-y-1">
      {sections.map((section, index) => {
        const complete =
          section.concepts.length > 0 &&
          section.masteredConcepts === section.concepts.length
        return (
          <button
            key={section.id}
            type="button"
            aria-current={
              section.id === activeSectionId ? "location" : undefined
            }
            onClick={() => onSelect(section.id)}
            className={cn(
              "group flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              section.id === activeSectionId && "bg-brand/10 text-foreground"
            )}
          >
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg border text-xs font-medium text-muted-foreground",
                complete && "border-emerald-500/40 text-emerald-600",
                section.id === activeSectionId &&
                  !complete &&
                  "border-brand/35 text-brand"
              )}
            >
              {complete ? (
                <CheckCircleIcon size={16} aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {section.title}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {section.masteredConcepts} of {section.concepts.length} concepts
              </span>
            </span>
            {section.hasNewMaterial ? (
              <span
                className="size-2 shrink-0 rounded-full bg-brand"
                aria-label="Updated"
              />
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

/** Renders a vertically scrolling walkthrough and its active side indicator. */
function WalkthroughStage({
  projectId,
  pathKey,
  items,
  onActiveItemChange,
}: {
  projectId: string
  pathKey: string
  items: StageItem[]
  onActiveItemChange: (item: StageItem) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const positionRailRef = useRef<HTMLElement>(null)
  const activeIndexRef = useRef(0)
  const exposedItemsRef = useRef(new Set<string>())
  const frameRef = useRef<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  /** Updates position, persistence, exposure, and the surrounding tool rail. */
  const activateIndex = useCallback(
    (index: number) => {
      if (!items.length) return
      const boundedIndex = Math.max(0, Math.min(index, items.length - 1))
      const item = items[boundedIndex]
      if (!item) return
      activeIndexRef.current = boundedIndex
      setActiveIndex(boundedIndex)
      onActiveItemChange(item)
      window.localStorage.setItem(storageKey(projectId, pathKey), item.id)
      if (!exposedItemsRef.current.has(item.id)) {
        exposedItemsRef.current.add(item.id)
        void recordWalkthroughExposure(projectId, item.id)
      }
    },
    [items, onActiveItemChange, pathKey, projectId]
  )

  /** Scrolls the requested card into place while respecting reduced motion. */
  const scrollToIndex = useCallback(
    (index: number, requestedBehavior?: ScrollBehavior) => {
      const container = containerRef.current
      if (!container) return
      const cards = container.querySelectorAll<HTMLElement>(
        "[data-walkthrough-card]"
      )
      const boundedIndex = Math.max(0, Math.min(index, cards.length - 1))
      const target = cards[boundedIndex]
      if (!target) return
      container.scrollTo({
        top: target.offsetTop,
        behavior:
          requestedBehavior ?? (prefersReducedMotion() ? "auto" : "smooth"),
      })
      activateIndex(boundedIndex)
    },
    [activateIndex]
  )

  /** Restores the last exact card after the stage mounts for this section. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const savedItemId = window.localStorage.getItem(
        storageKey(projectId, pathKey)
      )
      const savedIndex = items.findIndex((item) => item.id === savedItemId)
      scrollToIndex(savedIndex >= 0 ? savedIndex : 0)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [items, pathKey, projectId, scrollToIndex])

  /** Coalesces scroll work and chooses the nearest card after each movement. */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleScroll = () => {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        const nextIndex = closestCardIndex(container)
        if (nextIndex !== activeIndexRef.current) activateIndex(nextIndex)
      })
    }
    container.addEventListener("scroll", handleScroll, { passive: true })
    return () => {
      container.removeEventListener("scroll", handleScroll)
      if (frameRef.current !== null)
        window.cancelAnimationFrame(frameRef.current)
    }
  }, [activateIndex])

  /** Lets Up and Down move between cards unless a form control owns the keys. */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        shouldPreserveArrowKey(event.target)
      ) {
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        scrollToIndex(activeIndexRef.current + 1, "auto")
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        scrollToIndex(activeIndexRef.current - 1, "auto")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [scrollToIndex])

  /** Keeps the active marker visible as the hidden-scrollbar rail advances. */
  useEffect(() => {
    const activeMarker = positionRailRef.current?.querySelector<HTMLElement>(
      `[data-position-index="${activeIndex}"]`
    )
    activeMarker?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
  }, [activeIndex])

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={containerRef}
        tabIndex={0}
        aria-label="Walkthrough cards"
        aria-keyshortcuts="ArrowUp ArrowDown"
        className="h-full snap-y snap-proximity overflow-y-auto overscroll-y-contain scroll-smooth px-4 outline-none focus:outline-none focus-visible:outline-none sm:px-8 lg:px-10"
      >
        {items.map((item, index) => (
          <section
            key={item.id}
            data-walkthrough-card
            className="flex min-h-full snap-start items-center justify-center py-5 pr-7 sm:py-8 sm:pr-10"
          >
            <WalkthroughCard
              item={item}
              projectId={projectId}
              conceptTitle={item.conceptTitle}
              position={index}
              total={items.length}
              onNext={
                index < items.length - 1
                  ? () => scrollToIndex(index + 1)
                  : undefined
              }
            />
          </section>
        ))}
      </div>

      <nav
        ref={positionRailRef}
        aria-label="Walkthrough position"
        className="absolute top-1/2 right-2 flex max-h-[70%] -translate-y-1/2 [scrollbar-width:none] flex-col items-end gap-1 overflow-y-auto overscroll-contain py-2 sm:right-4 [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            title={item.title}
            aria-label={`Go to card ${index + 1}: ${item.title}`}
            aria-current={index === activeIndex ? "step" : undefined}
            data-position-index={index}
            onClick={() => scrollToIndex(index)}
            className="flex h-5 w-7 shrink-0 items-center justify-end rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span
              className={cn(
                "h-1.5 rounded-full bg-foreground/20 transition-[width,background-color] motion-reduce:transition-none",
                index === activeIndex ? "w-6 bg-brand" : "w-1.5"
              )}
            />
          </button>
        ))}
      </nav>
    </div>
  )
}

/** Renders the source-first project workspace and its responsive supporting panels. */
export function ProjectLearningWorkspace({
  projectId,
  projectTitle,
  sources,
  headerActions,
  sourceManager,
  onOpenSource,
}: ProjectLearningWorkspaceProps) {
  const path = useQuery(api.learning.getProjectPath, { projectId })
  const [selectedSectionId, setSelectedSectionId] = useState<string>()
  const [focusedConceptId, setFocusedConceptId] = useState<string>()
  const [activeItem, setActiveItem] = useState<StageItem>()
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)

  const defaultSection =
    path?.sections.find(
      (section) => section.masteredConcepts < section.concepts.length
    ) ?? path?.sections[0]
  const activeSection =
    path?.sections.find((section) => section.id === selectedSectionId) ??
    defaultSection
  const focusedConcept = activeSection?.concepts.find(
    (concept) => concept.id === focusedConceptId
  )
  const deepDiveConcepts = useMemo(() => {
    if (!focusedConcept || !path) return []
    const key = conceptKey(focusedConcept.title)
    return path.sections.flatMap((section) =>
      section.concepts.filter((concept) => conceptKey(concept.title) === key)
    )
  }, [focusedConcept, path])
  const stageItems = useMemo(
    () =>
      (focusedConcept
        ? deepDiveConcepts
        : (activeSection?.concepts ?? [])
      ).flatMap((concept) =>
        concept.items.map((item) => ({
          ...item,
          conceptTitle: concept.title,
        }))
      ),
    [activeSection?.concepts, deepDiveConcepts, focusedConcept]
  )
  const currentItem =
    stageItems.find((item) => item.id === activeItem?.id) ?? stageItems[0]
  const currentConcept = path?.sections
    .flatMap((section) => section.concepts)
    .find((concept) => concept.id === currentItem?.conceptId)
  const progressPercent = path?.stats.conceptCount
    ? Math.round(
        (path.stats.masteredConceptCount / path.stats.conceptCount) * 100
      )
    : 0
  const pathKey = `${activeSection?.id ?? "empty"}:${focusedConcept?.id ?? "full"}`

  /** Selects one generated section and returns to its complete walkthrough. */
  function selectSection(sectionId: string): void {
    setSelectedSectionId(sectionId)
    setFocusedConceptId(undefined)
    setActiveItem(undefined)
    setOutlineOpen(false)
  }

  /** Opens the active concept as a focused branch without losing section state. */
  function openDeepDive(): void {
    if (!currentConcept) return
    setFocusedConceptId(currentConcept.id)
    setActiveItem(undefined)
    setToolsOpen(false)
  }

  /** Returns from a focused concept branch to its parent section. */
  function closeDeepDive(): void {
    setFocusedConceptId(undefined)
    setActiveItem(undefined)
  }

  const pathList = path ? (
    <LearningPathList
      sections={path.sections}
      activeSectionId={activeSection?.id ?? ""}
      onSelect={selectSection}
    />
  ) : (
    <div className="space-y-3" aria-label="Loading learning path">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-14 rounded-xl" />
      ))}
    </div>
  )

  const toolPanel = (
    <div className="space-y-7">
      <section aria-labelledby="project-progress-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="project-progress-heading" className="font-heading text-xl">
            Progress
          </h2>
          <span className="text-sm font-medium">{progressPercent}%</span>
        </div>
        <Progress
          value={progressPercent}
          className="mt-3 h-1.5"
          aria-label={`${progressPercent}% of concepts mastered`}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {path
            ? `${path.stats.masteredConceptCount} of ${path.stats.conceptCount} concepts mastered`
            : "Loading project progress…"}
        </p>
      </section>

      <section
        className="border-t border-border/70 pt-6"
        aria-labelledby="study-tools-heading"
      >
        <h2 id="study-tools-heading" className="font-heading text-xl">
          Study tools
        </h2>
        <div className="mt-3 space-y-2">
          {focusedConcept ? (
            <Button
              type="button"
              variant="outline"
              onClick={closeDeepDive}
              className="min-h-11 w-full justify-start rounded-xl"
            >
              <ArrowLeftIcon size={17} /> Return to section
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={!currentConcept}
              onClick={openDeepDive}
              className="min-h-11 w-full justify-start rounded-xl"
            >
              <SparklesIcon size={17} /> Deep dive into this concept
            </Button>
          )}
          {currentItem ? (
            <Button
              asChild
              variant="outline"
              className="min-h-11 w-full justify-start rounded-xl"
            >
              <Link
                href={`/chat?cardProjectId=${encodeURIComponent(String(projectId))}&cardId=${encodeURIComponent(currentItem.id)}`}
              >
                <HelpIcon size={17} /> Ask Codex
              </Link>
            </Button>
          ) : null}
          <Button
            asChild
            variant="outline"
            className="min-h-11 w-full justify-start rounded-xl"
          >
            <Link
              href={`/projects/${encodeURIComponent(String(projectId))}/practice`}
            >
              <BookOpenIcon size={17} /> Quick questions
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full justify-start rounded-xl"
            onClick={() => {
              setToolsOpen(false)
              setSourcesOpen(true)
            }}
          >
            <FileIcon size={17} /> Manage sources
          </Button>
        </div>
      </section>

      <section
        className="border-t border-border/70 pt-6"
        aria-labelledby="current-concept-heading"
      >
        <h2
          id="current-concept-heading"
          className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          Current concept
        </h2>
        <p className="mt-2 font-medium">
          {currentConcept?.title ?? "Choose a section to begin"}
        </p>
        {currentConcept?.hasNewMaterial ? (
          <p className="mt-2 text-xs leading-5 text-brand">
            Updated with material from a newer source
          </p>
        ) : null}
        {currentConcept?.sourceLabels.length ? (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {currentConcept.sourceLabels.join(" · ")}
          </p>
        ) : null}
      </section>
    </div>
  )

  return (
    <main className="flex h-[calc(100svh-132px-env(safe-area-inset-bottom))] min-h-[560px] flex-col overflow-hidden bg-muted/25 font-sans md:h-svh">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-4 sm:px-6">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-11 rounded-full"
        >
          <Link href="/library" aria-label="Back to projects">
            <ArrowLeftIcon size={18} />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">Project</p>
          <h1 className="truncate font-heading text-xl font-medium sm:text-2xl">
            {projectTitle}
          </h1>
        </div>
        <div className="flex items-center gap-2">{headerActions}</div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[270px_minmax(0,1fr)_300px]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-border/70 bg-background px-3 py-5 lg:block">
          <div className="flex items-center justify-between gap-2 px-2">
            <h2 className="font-heading text-xl">Learning path</h2>
            <span className="text-xs text-muted-foreground">
              {path?.stats.sectionCount ?? 0} sections
            </span>
          </div>
          <div className="mt-4">{pathList}</div>

          <section
            className="mt-7 border-t border-border/70 px-2 pt-6"
            aria-labelledby="sources-heading"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id="sources-heading" className="font-heading text-xl">
                Sources
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9 rounded-full"
                onClick={() => setSourcesOpen(true)}
              >
                Manage
              </Button>
            </div>
            <div className="mt-3 space-y-1">
              {sources.slice(0, 8).map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => onOpenSource?.(source.id)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <FileIcon
                    size={16}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {source.filename}
                  </span>
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      source.status === "ready" && "bg-emerald-500",
                      source.status === "processing" && "bg-amber-500",
                      source.status === "failed" && "bg-destructive"
                    )}
                    aria-label={source.status}
                  />
                </button>
              ))}
              {!sources.length ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  Add a source to build your learning path.
                </p>
              ) : null}
            </div>
          </section>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/90 px-4 backdrop-blur sm:px-6">
            <Dialog open={outlineOpen} onOpenChange={setOutlineOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="min-h-10 rounded-full lg:hidden"
                >
                  <LayersIcon size={17} /> Sections
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[82svh] overflow-y-auto sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Learning path</DialogTitle>
                </DialogHeader>
                {pathList}
              </DialogContent>
            </Dialog>

            <div className="min-w-0 flex-1 text-center sm:text-left">
              <p className="truncate text-sm font-medium">
                {focusedConcept?.title ??
                  activeSection?.title ??
                  "Learning path"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {focusedConcept
                  ? `Deep dive · ${deepDiveConcepts.length} matching ${deepDiveConcepts.length === 1 ? "concept" : "concepts"}`
                  : activeSection
                    ? `${activeSection.concepts.length} concepts`
                    : "Generated from your sources"}
              </p>
            </div>

            <Dialog open={toolsOpen} onOpenChange={setToolsOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="min-h-10 rounded-full xl:hidden"
                >
                  <SparklesIcon size={17} /> Tools
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[82svh] overflow-y-auto sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Study tools</DialogTitle>
                </DialogHeader>
                {toolPanel}
              </DialogContent>
            </Dialog>
          </div>

          <div className="min-h-0 flex-1">
            {path === undefined ? (
              <div className="flex h-full items-center justify-center px-6">
                <div className="w-full max-w-2xl space-y-4" role="status">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-16 w-3/4" />
                  <Skeleton className="h-40 w-full rounded-[28px]" />
                </div>
              </div>
            ) : stageItems.length ? (
              <WalkthroughStage
                key={pathKey}
                projectId={String(projectId)}
                pathKey={pathKey}
                items={stageItems}
                onActiveItemChange={setActiveItem}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-md">
                  <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                    <SparklesIcon size={22} aria-hidden="true" />
                  </span>
                  <h2 className="mt-5 font-heading text-3xl">
                    Your path is taking shape
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Add source material and Blitz will sort it into topics,
                    concepts, walkthroughs, and questions.
                  </p>
                  <Button
                    type="button"
                    onClick={() => setSourcesOpen(true)}
                    className="mt-6 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
                  >
                    Add sources
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="hidden min-h-0 overflow-y-auto border-l border-border/70 bg-background px-5 py-6 xl:block">
          {toolPanel}
        </aside>
      </div>

      <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}>
        <DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Project sources</DialogTitle>
          </DialogHeader>
          {sourceManager}
        </DialogContent>
      </Dialog>
    </main>
  )
}
