"use client"

/** Presents cited source passages beside chat or in a full-screen mobile dialog. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PdfReader } from "@/components/ui/pdf-reader"
import { markdownHref } from "@/lib/markdown"

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
  const hasOriginalPdf = Boolean(
    result && result.fileUrl && result.mimeType === "application/pdf"
  )
  const markerRef = useRef<HTMLElement>(null)
  const [tab, setTab] = useState("")
  const activeTab = tab || (hasOriginalPdf ? "pdf" : "passage")
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
  const externalUrl = result.originalUrl
    ? markdownHref(result.originalUrl)
    : undefined
  const original = fileUrl
    ? `${fileUrl}${citation.page ? `#page=${citation.page}` : ""}`
    : externalUrl
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
            <a href={newTabUrl} target="_blank" rel="noopener noreferrer">
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
          {fileUrl && mimeType === "application/pdf" ? (
            <TabsTrigger value="pdf">Original PDF</TabsTrigger>
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
        {fileUrl && mimeType === "application/pdf" ? (
          <TabsContent
            value="pdf"
            forceMount
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 data-[state=inactive]:hidden"
          >
            <PdfReader
              url={fileUrl}
              initialPage={citation.page ?? 1}
              quote={citation.text}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </section>
  )
}
