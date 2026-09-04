"use client"

/** Renders the full-screen, fixture-driven learning feed used for visual review. */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { PreviewCard } from "@/components/preview/preview-card"
import {
  previewCards,
  type PreviewCardData,
} from "@/components/preview/preview-data"
import { PreviewChatPanel } from "@/components/preview/preview-chat-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ArrowLeftIcon } from "@/components/ui/icon"

/** Filter values supported by the fixture feed. */
type PreviewFilter = "all" | "explain" | "questions"

/** Human-readable filter labels kept close to the control that consumes them. */
const filterOptions: Array<{
  value: PreviewFilter
  label: string
}> = [
  { value: "all", label: "All cards" },
  { value: "explain", label: "Explanations" },
  { value: "questions", label: "Questions" },
]

/** Returns whether a fixture card belongs in the selected filter. */
function matchesFilter(card: PreviewCardData, filter: PreviewFilter) {
  if (filter === "all") return true
  if (filter === "explain") return card.type === "explain"
  return card.type !== "explain"
}

/** Provides wheel, button, and keyboard navigation over the local card sequence. */
export function PreviewFeed() {
  const feedRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<PreviewFilter>("all")
  const [activeIndex, setActiveIndex] = useState(0)
  const [chatCard, setChatCard] = useState<PreviewCardData | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [sessionMessage, setSessionMessage] = useState("")
  const visibleCards = useMemo(
    () => previewCards.filter((card) => matchesFilter(card, filter)),
    [filter]
  )
  const activeFilterLabel =
    filterOptions.find((option) => option.value === filter)?.label ??
    "All cards"

  /** Scrolls the bounded feed to a card and keeps the active index in sync. */
  const scrollToCard = useCallback(
    (index: number) => {
      const boundedIndex = Math.max(0, Math.min(index, visibleCards.length - 1))
      const container = feedRef.current
      if (!container) return
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      container.scrollTo({
        top: boundedIndex * container.clientHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      })
      setActiveIndex(boundedIndex)
    },
    [visibleCards.length]
  )

  useEffect(() => {
    feedRef.current?.scrollTo({ top: 0, behavior: "auto" })
  }, [filter])

  useEffect(() => {
    const container = feedRef.current
    if (!container) return
    const feedContainer = container

    /** Updates the visible card indicator as the user scrolls. */
    function handleScroll() {
      const nextIndex = Math.round(
        feedContainer.scrollTop / feedContainer.clientHeight
      )
      setActiveIndex(Math.max(0, Math.min(nextIndex, visibleCards.length - 1)))
    }

    feedContainer.addEventListener("scroll", handleScroll, { passive: true })
    return () => feedContainer.removeEventListener("scroll", handleScroll)
  }, [visibleCards.length])

  useEffect(() => {
    /** Maps arrow keys and page keys to feed movement while preserving form input. */
    function handleKeyDown(event: KeyboardEvent) {
      if (chatCard || filterOpen) return
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
  }, [activeIndex, chatCard, filterOpen, scrollToCard])

  /** Advances to the next fixture card and explains the end-of-slice behavior. */
  function skipCard(index: number) {
    if (index >= visibleCards.length - 1) {
      setSessionMessage("End of this example set · looping to the first card")
      scrollToCard(0)
      return
    }
    setSessionMessage("")
    scrollToCard(index + 1)
  }

  /** Applies a filter and closes its lightweight selection dialog. */
  function selectFilter(nextFilter: PreviewFilter) {
    setActiveIndex(0)
    setFilter(nextFilter)
    setFilterOpen(false)
    setSessionMessage("")
  }

  return (
    <main className="relative h-svh overflow-hidden bg-[#080808] text-white selection:bg-[#ff8065] selection:text-[#1b0d0a]">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="flex items-center justify-between gap-3">
          <Button
            asChild
            variant="ghost"
            className="pointer-events-auto h-10 rounded-[20px] bg-white/[0.045] px-3.5 text-sm text-white/65 ring-1 ring-white/10 hover:bg-white/[0.09] hover:text-white"
          >
            <Link href="/">
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              Exit
            </Link>
          </Button>

          <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="pointer-events-auto h-10 rounded-[20px] bg-white/[0.045] px-3.5 text-sm text-white/65 ring-1 ring-white/10 hover:bg-white/[0.09] hover:text-white"
              >
                <HugeiconsIcon
                  icon={FilterHorizontalIcon}
                  aria-hidden="true"
                  className="size-4"
                />
                <span className="hidden sm:inline">{activeFilterLabel}</span>
                <span className="sm:hidden">Filter</span>
              </Button>
            </DialogTrigger>
            <DialogContent
              aria-describedby={undefined}
              className="border-white/10 bg-[#151515] text-white sm:max-w-sm"
              showCloseButton
            >
              <DialogHeader>
                <DialogTitle className="font-sans text-white">
                  Filter this preview
                </DialogTitle>
              </DialogHeader>
              <div
                className="mt-2 space-y-2"
                role="radiogroup"
                aria-label="Preview filter"
              >
                {filterOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={filter === option.value}
                    onClick={() => selectFilter(option.value)}
                    className="flex w-full items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left transition-colors hover:border-white/22 hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-[#ff8065] focus-visible:outline-none"
                  >
                    <span className="mt-1 size-3 shrink-0 rounded-full border border-white/30 p-0.5">
                      <span className={cnRadio(filter === option.value)} />
                    </span>
                    <span className="text-sm font-medium text-white">
                      {option.label}
                    </span>
                  </button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div
        ref={feedRef}
        tabIndex={0}
        aria-label="Preview learning feed"
        className="h-full snap-y snap-mandatory [scrollbar-width:none] overflow-y-auto overscroll-y-contain scroll-smooth focus-visible:ring-2 focus-visible:ring-[#ff8065]/50 focus-visible:outline-none focus-visible:ring-inset [&::-webkit-scrollbar]:hidden"
      >
        {visibleCards.map((card, index) => (
          <PreviewCard
            key={card.id}
            card={card}
            index={index}
            onAsk={setChatCard}
            onSkip={skipCard}
          />
        ))}
      </div>

      <p aria-live="polite" className="sr-only">
        {sessionMessage}
      </p>

      <PreviewChatPanel
        key={chatCard?.id ?? "chat-closed"}
        card={chatCard}
        open={chatCard !== null}
        onOpenChange={(open) => {
          if (!open) setChatCard(null)
        }}
      />
    </main>
  )
}

/** Renders the selected state for the compact filter radio control. */
function cnRadio(selected: boolean) {
  return selected
    ? "size-full rounded-full bg-[#ff8065]"
    : "size-full rounded-full bg-transparent"
}
