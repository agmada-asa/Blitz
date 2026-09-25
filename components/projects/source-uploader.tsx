"use client"

/** Coordinates browser extraction, public-link fetching, and queue persistence. */

import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { useBackgroundNotice } from "@/components/background-notices"
import { useRef, useState, type DragEvent } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ResearchPanel } from "@/components/projects/research-panel"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Slider } from "@/components/ui/slider"
import { CancelIcon, FileIcon, LoadingIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  extractSourceResponse,
  type SourceKind,
} from "@/lib/client/extract-source"
import { sourcePartFilename, splitSourceText } from "@/lib/source-splitting"
import {
  CONTENT_DEPTHS,
  DEFAULT_CONTENT_DEPTH,
  contentDepth,
} from "@/lib/content-generation"

/** Convex operations and project identity required by source ingestion. */
type Props = {
  projectId: Id<"projects">
  depth?: number
  onDepthChange?: (depth: number) => Promise<unknown>
  initialResearchRequestId?: string
  createSource: (
    input: FunctionArgs<typeof api.sources.createSource>
  ) => Promise<FunctionReturnType<typeof api.sources.createSource>>
  updateSource: (
    input: FunctionArgs<typeof api.sources.updateSource>
  ) => Promise<FunctionReturnType<typeof api.sources.updateSource>>
  enqueueContent: (input: {
    projectId: Id<"projects">
    sourceId: Id<"sources">
  }) => Promise<unknown>
}

/** One recoverable result from a bulk source import. */
type ImportResult = {
  filename: string
  status: "queued" | "failed"
  detail: string
}

/** The source entry method selected in the shared shadcn tab strip. */
type SourceTab = "files" | "paste" | "link" | "research"

/** Outcome of sequentially saving a bounded source part list. */
type QueuePartsResult = {
  queuedFilenames: string[]
  failed?: { filename: string; detail: string }
}

/** Returns a useful error message without exposing arbitrary response objects. */
function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

/** Reads a JSON error body from the public-link route when available. */
async function responseError(
  response: Response,
  fallback: string
): Promise<Error> {
  try {
    const payload = (await response.json()) as unknown
    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
    )
      return new Error(payload.error)
  } catch {
    // Use the bounded fallback when the route did not return JSON.
  }
  return new Error(fallback)
}

/** Renders file, paste, and public-link imports as quick queue submissions. */
export function SourceUploader({
  projectId,
  depth = DEFAULT_CONTENT_DEPTH,
  onDepthChange,
  initialResearchRequestId,
  createSource,
  updateSource,
  enqueueContent,
}: Props) {
  const notifyBackground = useBackgroundNotice()
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const pendingDepthSave = useRef<Promise<boolean> | null>(null)
  const [dragging, setDragging] = useState(false)
  const [activeTab, setActiveTab] = useState<SourceTab>(
    initialResearchRequestId ? "research" : "files"
  )
  const [paste, setPaste] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedDepth, setSelectedDepth] = useState(depth)
  const [depthError, setDepthError] = useState("")
  const [message, setMessage] = useState<{
    type: "error" | "success"
    text: string
  }>()
  const [results, setResults] = useState<ImportResult[]>([])

  /** Saves a selected depth for jobs queued after this change. */
  function saveDepth(value: number): void {
    if (!onDepthChange) return
    setDepthError("")
    pendingDepthSave.current = onDepthChange(value).then(
      () => true,
      () => {
        setSelectedDepth(depth)
        setDepthError("Detail setting could not be saved. Try again.")
        return false
      }
    )
  }

  /** Prevents a source from snapshotting the old detail level during a save. */
  async function waitForDepth(): Promise<void> {
    if (pendingDepthSave.current && !(await pendingDepthSave.current))
      throw new Error("Save the lesson detail setting before adding sources.")
  }

  /** Highlights the upload target only while a file drag is over it. */
  function enterDropZone(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  /** Clears the highlight after the file drag leaves the upload target. */
  function leaveDropZone(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  /** Imports files dropped on the upload target through the normal file flow. */
  function dropFiles(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!busy) void chooseFiles(Array.from(event.dataTransfer.files))
  }

  /** Creates one source snapshot and queues it for content generation. */
  const queueSource = async (
    filename: string,
    kind: SourceKind,
    text: string,
    originalUrl?: string
  ): Promise<void> => {
    if (!text.trim())
      throw new Error("There was no readable text in that source.")
    await waitForDepth()
    let sourceId: Id<"sources"> | undefined
    try {
      sourceId = await createSource({
        projectId,
        filename,
        kind,
        extractedText: text,
        ...(originalUrl ? { originalUrl } : {}),
      })
      await enqueueContent({ projectId, sourceId })
    } catch (error) {
      if (sourceId) {
        await updateSource({
          sourceId,
          status: "failed",
          error: messageForError(error, "This source could not be queued."),
        }).catch(() => undefined)
      }
      throw error
    }
  }

  /** Saves every bounded part while retaining successful parts after a later failure. */
  const queueSourceParts = async (
    filename: string,
    kind: SourceKind,
    text: string,
    originalUrl?: string
  ): Promise<QueuePartsResult> => {
    if (!text.trim())
      throw new Error("There was no readable text in that source.")
    const parts = splitSourceText(text)
    const queuedFilenames: string[] = []
    for (const part of parts) {
      const partFilename = sourcePartFilename(
        filename,
        part.partNumber,
        part.totalParts
      )
      try {
        await queueSource(partFilename, kind, part.text, originalUrl)
        queuedFilenames.push(partFilename)
      } catch (error) {
        return {
          queuedFilenames,
          failed: {
            filename: partFilename,
            detail: messageForError(error, "This part could not be queued."),
          },
        }
      }
    }
    return { queuedFilenames }
  }

  /** Imports selected files one at a time so later files can still be saved after a failure. */
  const chooseFiles = async (files: File[]): Promise<void> => {
    const selected = files
    if (!selected.length) return
    setBusy(true)
    setMessage(undefined)
    setResults([])
    const imported: ImportResult[] = []
    for (const file of selected) {
      try {
        await waitForDepth()
        const originalResponse = await fetch("/api/sources/upload", {
          method: "POST",
          headers: {
            "x-blitz-project-id": String(projectId),
            "x-blitz-filename": file.name,
            ...(file.type ? { "content-type": file.type } : {}),
          },
          body: file,
        })
        if (!originalResponse.ok)
          throw await responseError(
            originalResponse,
            "The original file could not be stored."
          )
        const upload = (await originalResponse.json()) as {
          unsupported?: boolean
          extracted?: boolean
          duplicate?: boolean
          error?: string
        }
        if (!upload.extracted && !upload.duplicate && !upload.unsupported)
          throw new Error(upload.error || "The source could not be extracted.")
        else
          imported.push({
            filename: file.name,
            status: "queued",
            detail: upload.duplicate
              ? "This file is already uploaded."
              : "Uploaded and queued for content generation.",
          })
      } catch (error) {
        const detail = messageForError(error, "Could not read that file.")
        imported.push({ filename: file.name, status: "failed", detail })
      }
      setResults([...imported])
    }
    const failed = imported.filter((item) => item.status === "failed").length
    setMessage({
      type: failed ? "error" : "success",
      text: failed
        ? `${failed} file${failed === 1 ? "" : "s"} could not be saved. Review the details below.`
        : `${imported.length} file${imported.length === 1 ? "" : "s"} uploaded.`,
    })
    const queuedCount = imported.filter(
      (item) => item.status === "queued"
    ).length
    if (queuedCount)
      notifyBackground(
        "Content generation continues in the background.",
        "/notifications",
        "View notifications"
      )
    setBusy(false)
  }

  /** Queues pasted notes without waiting for local concept generation. */
  const queuePaste = async (): Promise<void> => {
    if (!paste.trim()) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await queueSourceParts("Pasted notes", "paste", paste)
      if (result.failed) {
        setResults([
          {
            filename: "Pasted notes",
            status: "failed",
            detail: `${result.queuedFilenames.length} part${result.queuedFilenames.length === 1 ? "" : "s"} queued; ${result.failed.filename}: ${result.failed.detail}`,
          },
        ])
        setMessage({
          type: "error",
          text: result.queuedFilenames.length
            ? "Some notes were queued. Select them again to retry the remaining parts."
            : "The notes could not be saved. Try again.",
        })
      } else {
        setResults([
          {
            filename: "Pasted notes",
            status: "queued",
            detail:
              result.queuedFilenames.length === 1
                ? "Queued"
                : `Queued ${result.queuedFilenames.length} parts`,
          },
        ])
        setMessage({
          type: "success",
          text: "Notes queued for content generation.",
        })
        notifyBackground(
          "Content generation continues in the background.",
          "/notifications",
          "View notifications"
        )
        setPaste("")
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: messageForError(error, "Notes could not be queued."),
      })
    } finally {
      setBusy(false)
    }
  }

  /** Fetches and extracts one public URL before creating its source snapshot. */
  const importUrl = async (): Promise<void> => {
    if (!url.trim()) return
    setBusy(true)
    setMessage(undefined)
    try {
      const response = await fetch("/api/sources/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      })
      if (!response.ok)
        throw await responseError(response, "That source could not be fetched.")
      const source = await extractSourceResponse(response, url.trim())
      const result = await queueSourceParts(
        source.filename,
        source.kind,
        source.text,
        response.headers.get("x-source-url") ?? url.trim()
      )
      if (result.failed) {
        setResults([
          {
            filename: source.filename,
            status: "failed",
            detail: `${result.queuedFilenames.length} part${result.queuedFilenames.length === 1 ? "" : "s"} queued; ${result.failed.filename}: ${result.failed.detail}`,
          },
        ])
        setMessage({
          type: "error",
          text: result.queuedFilenames.length
            ? "Some link content was queued. Retry to save the remaining parts."
            : "The link content could not be saved. Try again.",
        })
      } else {
        setResults([
          {
            filename: source.filename,
            status: "queued",
            detail:
              result.queuedFilenames.length === 1
                ? "Queued"
                : `Queued ${result.queuedFilenames.length} parts`,
          },
        ])
        setMessage({
          type: "success",
          text: "Link queued for content generation.",
        })
        notifyBackground(
          "Content generation continues in the background.",
          "/notifications",
          "View notifications"
        )
        setUrl("")
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: messageForError(error, "That link could not be imported."),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      id="add-source"
      aria-busy={busy}
      className="scroll-mt-6 overflow-visible border-border bg-card font-sans"
    >
      <CardContent className="p-5 sm:p-7">
        <h2 className="mb-4 font-heading text-xl">Add sources</h2>
        <div className="mb-6 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="content-depth" className="text-sm font-medium">
              Lesson detail
            </label>
            <span className="text-sm text-muted-foreground">
              {contentDepth(selectedDepth).label}
            </span>
          </div>
          <Slider
            id="content-depth"
            aria-label="Lesson detail"
            min={1}
            max={5}
            step={1}
            value={[selectedDepth]}
            disabled={busy || !onDepthChange}
            onValueChange={(values) =>
              setSelectedDepth(values[0] ?? DEFAULT_CONTENT_DEPTH)
            }
            onValueCommit={(values) =>
              saveDepth(values[0] ?? DEFAULT_CONTENT_DEPTH)
            }
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{CONTENT_DEPTHS[0].label}</span>
            <span>{CONTENT_DEPTHS[4].label}</span>
          </div>
          {depthError ? (
            <p role="alert" className="text-sm text-destructive">
              {depthError}
            </p>
          ) : null}
        </div>
        {busy ? (
          <p role="status" className="mb-4 text-sm text-muted-foreground">
            Keep this page open while uploading.
          </p>
        ) : null}

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SourceTab)}
          className="gap-0"
        >
          <TabsList
            aria-label="Source input type"
            className="mb-4 h-auto max-w-full flex-wrap justify-start"
          >
            <TabsTrigger value="files" disabled={busy}>
              Upload
            </TabsTrigger>
            <TabsTrigger value="paste" disabled={busy}>
              Paste
            </TabsTrigger>
            <TabsTrigger value="link" disabled={busy}>
              Link
            </TabsTrigger>
            <TabsTrigger value="research" disabled={busy}>
              Deep Research
            </TabsTrigger>
          </TabsList>
          <Input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ""
              void chooseFiles(files)
            }}
          />
          <TabsContent value="files" className="mt-0">
            <div
              onDragEnter={enterDropZone}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={leaveDropZone}
              onDrop={dropFiles}
              className={
                dragging
                  ? "flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border-2 border-brand bg-brand/10 p-4 text-center"
                  : "flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-4 text-center"
              }
            >
              <p className="text-sm text-muted-foreground">Drop files here</p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="min-h-10 rounded-lg"
              >
                Upload files
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="paste" className="mt-0">
            <Textarea
              aria-label="Notes to prepare"
              value={paste}
              disabled={busy}
              onChange={(event) => setPaste(event.target.value)}
              placeholder="Drop your notes here…"
              className="min-h-28 flex-1 resize-none"
            />
            <Button
              type="button"
              disabled={busy || !paste.trim()}
              onClick={() => void queuePaste()}
              className="mt-2 w-full rounded-lg"
            >
              {busy ? (
                <>
                  <LoadingIcon
                    className="animate-spin motion-reduce:animate-none"
                    size={16}
                  />
                  Importing notes…
                </>
              ) : (
                <span>Import notes</span>
              )}
            </Button>
          </TabsContent>

          <TabsContent
            value="link"
            className="mt-0 flex flex-col gap-2 sm:flex-row"
          >
            <Input
              type="url"
              aria-label="Public source link"
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/your-notes"
            />
            <Button
              type="button"
              disabled={busy || !url.trim()}
              onClick={() => void importUrl()}
              className="w-full shrink-0 rounded-lg sm:w-auto"
            >
              {busy ? "Importing…" : "Import link"}
            </Button>
          </TabsContent>
          <TabsContent
            value="research"
            forceMount
            className="mt-0 data-[state=inactive]:hidden"
          >
            <ResearchPanel
              key={String(projectId)}
              projectId={String(projectId)}
              initialRequestId={initialResearchRequestId}
              active={activeTab === "research"}
            />
          </TabsContent>
        </Tabs>

        {results.length ? (
          <div className="mt-4 space-y-2" aria-live="polite">
            {results.map((result, index) => (
              <div
                key={`${result.filename}-${index}`}
                className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs"
              >
                <FileIcon size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {result.filename}
                </span>
                <span
                  className={
                    result.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {result.detail}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {message ? (
          <p
            aria-live="polite"
            className={`mt-4 rounded-lg px-3 py-2 text-sm ${message.type === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"}`}
          >
            {message.text}
          </p>
        ) : null}

        {!busy && results.length ? (
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setResults([])}
          >
            <CancelIcon size={14} /> Clear import details
          </button>
        ) : null}
      </CardContent>
    </Card>
  )
}
