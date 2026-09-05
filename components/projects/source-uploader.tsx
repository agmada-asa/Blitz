"use client"

/** Coordinates browser extraction, public-link fetching, and queue persistence. */

import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { useBackgroundNotice } from "@/components/background-notices"
import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  CancelIcon,
  ClipboardPasteIcon,
  FileIcon,
  FileUploadIconComponent,
  LinkIcon,
  LoadingIcon,
} from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  extractSource,
  extractSourceResponse,
  type SourceKind,
} from "@/lib/client/extract-source"
import { sourcePartFilename, splitSourceText } from "@/lib/source-splitting"

/** Convex operations and project identity required by source ingestion. */
type Props = {
  projectId: Id<"projects">
  createSource: (
    input: FunctionArgs<typeof api.sources.createSource>
  ) => Promise<FunctionReturnType<typeof api.sources.createSource>>
  updateSource: (
    input: FunctionArgs<typeof api.sources.updateSource>
  ) => Promise<FunctionReturnType<typeof api.sources.updateSource>>
  enqueue: (
    input: FunctionArgs<typeof api.preparation.enqueue>
  ) => Promise<FunctionReturnType<typeof api.preparation.enqueue>>
  /** Optional atomic source and preparation mutation used by the live route. */
  createAndEnqueue?: (
    input: FunctionArgs<typeof api.sources.createAndEnqueue>
  ) => Promise<FunctionReturnType<typeof api.sources.createAndEnqueue>>
}

/** One recoverable result from a bulk source import. */
type ImportResult = {
  filename: string
  status: "queued" | "failed"
  detail: string
}

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
  createSource,
  updateSource,
  enqueue,
  createAndEnqueue,
}: Props) {
  const notifyBackground = useBackgroundNotice()
  const inputRef = useRef<HTMLInputElement>(null)
  const [paste, setPaste] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    type: "error" | "success"
    text: string
  }>()
  const [results, setResults] = useState<ImportResult[]>([])

  /** Creates one source snapshot and queues it for local preparation. */
  const queueSource = async (
    filename: string,
    kind: SourceKind,
    text: string,
    originalUrl?: string
  ): Promise<void> => {
    if (!text.trim())
      throw new Error("There was no readable text in that source.")
    if (createAndEnqueue) {
      await createAndEnqueue({
        projectId,
        filename,
        kind,
        extractedText: text,
        ...(originalUrl ? { originalUrl } : {}),
      })
      return
    }
    let sourceId: Id<"sources"> | undefined
    try {
      sourceId = await createSource({
        projectId,
        filename,
        kind,
        extractedText: text,
        ...(originalUrl ? { originalUrl } : {}),
      })
      await enqueue({ projectId, sourceId })
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
        const source = await extractSource(file)
        const result = await queueSourceParts(
          source.filename,
          source.kind,
          source.text
        )
        imported.push(
          result.failed
            ? {
                filename: file.name,
                status: "failed",
                detail: `${result.queuedFilenames.length} part${result.queuedFilenames.length === 1 ? "" : "s"} queued; ${result.failed.filename}: ${result.failed.detail}`,
              }
            : {
                filename: file.name,
                status: "queued",
                detail:
                  result.queuedFilenames.length === 1
                    ? "Queued"
                    : `Queued ${result.queuedFilenames.length} parts`,
              }
        )
      } catch (error) {
        imported.push({
          filename: file.name,
          status: "failed",
          detail: messageForError(error, "Could not read that file."),
        })
      }
      setResults([...imported])
    }
    const failed = imported.filter((item) => item.status === "failed").length
    setMessage({
      type: failed ? "error" : "success",
      text: failed
        ? `${imported.length - failed} source${imported.length - failed === 1 ? "" : "s"} queued; ${failed} could not be imported.`
        : `${imported.length} source${imported.length === 1 ? "" : "s"} queued for preparation.`,
    })
    const queuedCount = imported.filter(
      (item) => item.status === "queued"
    ).length
    if (queuedCount)
      notifyBackground(
        "Card preparation continues in the background.",
        "/activity",
        "View activity"
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
        setMessage({ type: "success", text: "Notes queued for preparation." })
        notifyBackground(
          "Card preparation continues in the background.",
          "/activity",
          "View activity"
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
        setMessage({ type: "success", text: "Link queued for preparation." })
        notifyBackground(
          "Card preparation continues in the background.",
          "/activity",
          "View activity"
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
      className="scroll-mt-6 overflow-visible border-transparent bg-card font-sans"
    >
      <CardContent className="p-5 sm:p-7">
        <h2 className="mb-4 font-heading text-xl">Add sources</h2>
        {busy ? (
          <p role="status" className="mb-4 text-sm text-muted-foreground">
            Keep this page open while uploading.
          </p>
        ) : null}

        <Tabs defaultValue="files" className="gap-0">
          <TabsList aria-label="Source input type" className="mb-4">
            <TabsTrigger value="files" disabled={busy}>
              Upload
            </TabsTrigger>
            <TabsTrigger value="paste" disabled={busy}>
              Paste
            </TabsTrigger>
            <TabsTrigger value="link" disabled={busy}>
              Link
            </TabsTrigger>
          </TabsList>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.md,.markdown,.txt,.pptx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ""
              void chooseFiles(files)
            }}
          />
          <div className="rounded-xl border border-border/70 p-3 sm:p-4">
            <TabsContent
              value="files"
              className="mt-0 flex items-center justify-between gap-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                <FileUploadIconComponent
                  className="shrink-0 text-muted-foreground"
                  size={24}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Upload files</p>
                  <p className="truncate text-xs text-muted-foreground">
                    PDF · MD · TXT · PPTX · multiple files supported
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="shrink-0 rounded-lg"
              >
                Choose files
              </Button>
            </TabsContent>

            <TabsContent value="paste" className="mt-0">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ClipboardPasteIcon size={17} /> Paste notes
              </div>
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
                  <LoadingIcon
                    className="animate-spin motion-reduce:animate-none"
                    size={16}
                  />
                ) : (
                  <span>Queue notes</span>
                )}
              </Button>
            </TabsContent>

            <TabsContent value="link" className="mt-0 flex gap-2">
              <LinkIcon
                className="mt-2 shrink-0 text-muted-foreground"
                size={17}
              />
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
                className="shrink-0 rounded-lg"
              >
                {busy ? "Importing…" : "Import link"}
              </Button>
            </TabsContent>
          </div>
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
