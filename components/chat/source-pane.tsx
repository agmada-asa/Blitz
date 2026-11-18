"use client"

/**
 * Presents cited source passages beside chat or in a full-screen mobile dialog.
 *
 * Every citation shows its extracted passage. When Blitz can draw the
 * original (`originalViewer` in `lib/source-viewers.ts`), the reader opens on
 * it instead: PDF pages, PowerPoint slides, a Word document, or formatted
 * Markdown, each at the cited place with the passage highlighted.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import dynamic from "next/dynamic"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Markdown } from "@/components/ui/markdown"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PdfReader } from "@/components/ui/pdf-reader"
import { citationOriginalUrl } from "@/lib/citations"
import {
  clearQuoteHighlight,
  highlightQuote,
  scrollRangeIntoView,
} from "@/lib/client/source-highlight"
import { markdownHref } from "@/lib/markdown"
import {
  citedSlide,
  ORIGINAL_VIEWER_LABELS,
  originalViewer,
} from "@/lib/source-viewers"

/** Loading copy shared by the readers that load on demand. */
function ReaderLoading() {
  return (
    <p role="status" className="p-5 text-sm text-muted-foreground">
      Loading original…
    </p>
  )
}

/** Slide reader, loaded only when a PowerPoint source is opened. */
const SlidesReader = dynamic(
  () => import("@/components/ui/slides-reader").then((mod) => mod.SlidesReader),
  { ssr: false, loading: ReaderLoading }
)

/** Word reader, loaded only when a Word source is opened. */
const DocumentReader = dynamic(
  () =>
    import("@/components/ui/document-reader").then((mod) => mod.DocumentReader),
  { ssr: false, loading: ReaderLoading }
)

/**
 * Shows Markdown source text formatted, scrolled to the cited passage with it
 * highlighted.
 *
 * @param text The source's extracted Markdown (or the cited section of a book).
 * @param quote The cited passage within it.
 */
function FormattedReader({ text, quote }: { text: string; quote: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = scrollRef.current
    const body = bodyRef.current
    if (!scroller || !body) return
    const range = highlightQuote(body, quote)
    if (range) scrollRangeIntoView(range, scroller)
    return clearQuoteHighlight
  }, [text, quote])
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div ref={bodyRef} className="text-sm leading-7 break-words">
        <Markdown text={text} />
      </div>
    </div>
  )
}

/** Identifies one citation through its owning saved message. */
export type SourceSelection = {
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
  citationId: string
}

/** Identifies a source citation attached to a project learning item. */
export type LearningSourceSelection = {
  kind: "learning"
  projectId: Id<"projects">
  sourceId: Id<"sources">
  filename: string
  locator?: string
}

/** Subscribes to the breakpoint without mismatching the server render. */
function subscribeWidth(callback: () => void) {
  const media = window.matchMedia("(min-width: 1024px)")
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}
/** Reads whether the viewport has space for simultaneous chat and source reading. */
function desktopWidth() {
  return window.matchMedia("(min-width: 1024px)").matches
}
/** Uses the mobile dialog until the browser can supply viewport dimensions. */
function serverWidth() {
  return false
}

/** Displays an independently scrollable source reader and restores focus when dismissed. */
export function SourcePane({
  selection,
  onClose,
}: {
  selection: SourceSelection | LearningSourceSelection
  onClose: () => void
}) {
  const desktop = useSyncExternalStore(
    subscribeWidth,
    desktopWidth,
    serverWidth
  )
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    closeRef.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const reader = <SourceReader selection={selection} />
  if (!desktop)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent
          className="h-[100dvh] max-h-none max-w-none rounded-none p-0 sm:max-w-none"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Source reader</DialogTitle>
          {reader}
        </DialogContent>
      </Dialog>
    )
  return (
    <aside
      aria-label="Source reader"
      className={
        "kind" in selection
          ? "sticky top-6 flex h-[calc(100dvh-3rem)] w-full min-w-0 flex-col border-l bg-background"
          : "flex h-full w-[min(45vw,680px)] min-w-96 shrink-0 flex-col border-l bg-background"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex justify-end border-b px-3 py-1">
        <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose}>
          Close source
        </Button>
      </div>
      {reader}
    </aside>
  )
}

/** Loads the source by citation identity and scrolls directly to the highlighted saved passage. */
export function SourceReader({
  selection,
}: {
  selection: SourceSelection | LearningSourceSelection
}) {
  const chatResult = useQuery(
    api.chatCitations.read,
    "kind" in selection ? "skip" : selection
  )
  const learningResult = useQuery(
    api.learning.readSourceCitation,
    "kind" in selection
      ? {
          projectId: selection.projectId,
          sourceId: selection.sourceId,
          locator: selection.locator,
        }
      : "skip"
  )
  const result = "kind" in selection ? learningResult : chatResult
  const viewer = result
    ? originalViewer({
        mimeType: result.mimeType,
        filename: result.citation.filename,
        fileUrl: result.fileUrl,
        textLength: result.text.length,
      })
    : undefined
  const markerRef = useRef<HTMLElement>(null)
  const [tab, setTab] = useState("")
  // The original opens first when it can be drawn; the passage is one tap away.
  const activeTab = tab || (viewer ? "original" : "passage")
  useEffect(() => {
    if (activeTab === "passage")
      markerRef.current?.scrollIntoView({
        block: "center",
        behavior: "instant",
      })
  }, [result, activeTab])
  if (result === undefined)
    return (
      <p role="status" className="p-6">
        Loading source…
      </p>
    )
  if (!result)
    return (
      <p role="alert" className="p-6">
        This citation is no longer available. Return to the chat and ask for a
        new reference.
      </p>
  )
  const { citation, text, startOffset, endOffset, fileUrl, mimeType } = result
  // Opens the PDF page, or the web page scrolled to the passage, when the source allows it.
  const original = citationOriginalUrl(citation, {
    fileUrl,
    mimeType,
    webUrl: result.originalUrl ? markdownHref(result.originalUrl) : undefined,
  })
  const newTabUrl = "kind" in selection
    ? `/sources/learning-view?projectId=${encodeURIComponent(selection.projectId)}&sourceId=${encodeURIComponent(selection.sourceId)}${selection.locator ? `&locator=${encodeURIComponent(selection.locator)}` : ""}`
    : `/sources/view?chatId=${encodeURIComponent(selection.chatId)}&messageId=${encodeURIComponent(selection.messageId)}&citationId=${encodeURIComponent(selection.citationId)}`
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="space-y-2 border-b px-5 py-4 pr-12">
        <h2 className="font-medium break-words">{citation.filename}</h2>
        <p className="text-sm text-muted-foreground">{citation.label}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="link" className="h-auto p-0 text-xs">
            {/* Keeps the referrer so the new tab counts as reached from Blitz
                and stays in this browser (`lib/client/desktop-links.ts`). */}
            <a href={newTabUrl} target="_blank" rel="noopener">
              Open in new tab
            </a>
          </Button>
          {original ? (
            <Button asChild variant="link" className="h-auto p-0 text-xs">
              <a href={original} target="_blank" rel="noopener noreferrer">
                Open original
              </a>
            </Button>
          ) : null}
        </div>
      </header>
      <Tabs
        value={activeTab}
        onValueChange={setTab}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList className="mx-5 mt-3 shrink-0" aria-label="Source view">
          <TabsTrigger value="passage">Passage</TabsTrigger>
          {viewer ? (
            <TabsTrigger value="original">
              {ORIGINAL_VIEWER_LABELS[viewer]}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent
          value="passage"
          forceMount
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5 data-[state=inactive]:hidden"
        >
          {result.snapshotOnly ? (
            <p className="mb-4 text-xs text-muted-foreground">
              Showing the passage saved with this reply.
            </p>
          ) : null}
          <div className="text-sm leading-7 break-words whitespace-pre-wrap">
            {text.slice(0, startOffset)}
            <mark
              ref={markerRef}
              className="rounded-sm bg-brand/20 text-foreground outline-2 outline-brand/40"
              tabIndex={-1}
            >
              {text.slice(startOffset, endOffset)}
            </mark>
            {text.slice(endOffset)}
          </div>
        </TabsContent>
        {viewer === "pdf" && fileUrl ? (
          <TabsContent
            value="original"
            forceMount
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 data-[state=inactive]:hidden"
          >
            <PdfReader
              url={fileUrl}
              initialPage={citation.page ?? 1}
              quote={citation.text}
            />
          </TabsContent>
        ) : viewer ? (
          // Other originals load each time their tab opens, so they scroll to the passage again.
          <TabsContent
            value="original"
            className="flex min-h-0 flex-1 flex-col"
          >
            {viewer === "slides" && fileUrl ? (
              <SlidesReader
                url={fileUrl}
                slide={citedSlide(citation)}
                quote={citation.text}
              />
            ) : viewer === "document" && fileUrl ? (
              <DocumentReader url={fileUrl} quote={citation.text} />
            ) : (
              <FormattedReader text={text} quote={citation.text} />
            )}
          </TabsContent>
        ) : null}
      </Tabs>
    </section>
  )
}
