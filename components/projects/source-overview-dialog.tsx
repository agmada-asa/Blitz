"use client"

/**
 * Presents a comprehensive source overview modal when clicking on a source in the workspace.
 *
 * Provides file metadata, AI document summary, live processing and retry controls,
 * rich inline preview (PDF reader, markdown, plain text, image), and explicit download.
 */

import { useState } from "react"
import Image from "next/image"
import { useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  ComputerIconComponent,
  FileIcon,
  FolderIcon,
  LoadingIcon,
  RotateLeftIcon,
} from "@/components/ui/icon"
import { Markdown } from "@/components/ui/markdown"
import { PdfReader } from "@/components/ui/pdf-reader"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type {
  ProjectFileCitation,
  ProjectFileIngestion,
  ProjectFilePreparation,
  ProjectFileSource,
} from "@/components/projects/project-files"

/** Formats byte sizes into human-readable strings without fractional jitter. */
function formatSize(sizeBytes?: number): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return undefined
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Formats an epoch millisecond timestamp into a localized readable date. */
function formatDate(timestamp?: number): string | undefined {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Returns status label and badge variant matching Blitz design conventions. */
function getSourceStatusInfo(
  status: "processing" | "ready" | "failed" | undefined,
  job?: ProjectFileIngestion,
  preparationJob?: ProjectFilePreparation,
  unsupported?: boolean
): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (unsupported) {
    return { label: "Unsupported file", variant: "outline" }
  }
  if (
    job?.status === "failed" ||
    preparationJob?.status === "failed" ||
    status === "failed"
  ) {
    return { label: "Needs attention", variant: "destructive" }
  }
  if (
    job?.status === "running" ||
    job?.status === "queued" ||
    preparationJob?.status === "leased" ||
    preparationJob?.status === "queued" ||
    status === "processing"
  ) {
    return {
      label:
        job?.status === "queued" || preparationJob?.status === "queued"
          ? "Queued"
          : "Ingesting",
      variant: "outline",
    }
  }
  return { label: "Ready", variant: "secondary" }
}

/** Props for the SourceOverviewDialog. */
export type SourceOverviewDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  source: ProjectFileSource | null
  ingestionJob?: ProjectFileIngestion
  preparationJob?: ProjectFilePreparation
  citations?: ProjectFileCitation[]
  onRetryIngestion?: (sourceId: string) => Promise<void>
  onOpenDesktopFile?: (relativeKey: string) => void
  onRevealDesktopFile?: (relativeKey: string) => void
}

/** Renders a rich source overview with preview, status tracking, and download capabilities. */
export function SourceOverviewDialog({
  open,
  onOpenChange,
  projectId,
  source: initialSource,
  ingestionJob,
  preparationJob,
  citations = [],
  onRetryIngestion,
  onOpenDesktopFile,
  onRevealDesktopFile,
}: SourceOverviewDialogProps) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string>()

  // Fetch complete real-time source record (including extractedText and live status updates)
  const reactiveSource = useQuery(
    api.sources.getSource,
    initialSource && open
      ? {
          projectId: projectId as Id<"projects">,
          sourceId: initialSource._id as Id<"sources">,
        }
      : "skip"
  )

  const activeSource = reactiveSource ?? initialSource
  if (!activeSource) return null

  const filename = activeSource.filename
  const sourceId = String(activeSource._id)
  const status = activeSource.status
  const unsupported = activeSource.unsupported
  const statusInfo = getSourceStatusInfo(
    status,
    ingestionJob,
    preparationJob,
    unsupported
  )

  const mimeType = activeSource.mimeType ?? ""
  const isPdf =
    mimeType === "application/pdf" ||
    (!mimeType && filename.toLowerCase().endsWith(".pdf"))
  const isMarkdown =
    mimeType === "text/markdown" ||
    (!mimeType &&
      (filename.toLowerCase().endsWith(".md") ||
        filename.toLowerCase().endsWith(".markdown")))
  const isImage =
    mimeType.startsWith("image/") ||
    (!mimeType && /\.(png|jpe?g|webp|gif|svg)$/i.test(filename))
  const isText =
    mimeType.startsWith("text/") ||
    isMarkdown ||
    Boolean(activeSource.extractedText)

  const hasPreview = isPdf || isMarkdown || isImage || isText

  const progress =
    preparationJob?.totalChunks && preparationJob.totalChunks > 0
      ? Math.min(
          100,
          ((preparationJob.nextChunkOrdinal ?? 0) /
            preparationJob.totalChunks) *
            100
        )
      : undefined

  const downloadUrl = `/api/sources/file?projectId=${encodeURIComponent(projectId)}&sourceId=${encodeURIComponent(sourceId)}`
  const inlinePreviewUrl = `${downloadUrl}&inline=1`

  /** Handles re-triggering ingestion for failed sources. */
  async function handleRetry() {
    if (!onRetryIngestion) return
    setRetrying(true)
    setRetryError(undefined)
    try {
      await onRetryIngestion(sourceId)
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed.")
    } finally {
      setRetrying(false)
    }
  }

  // Choose default tab: if failed/processing, overview is primary; if ready and previewable, preview is primary
  const defaultTab =
    status === "failed" || status === "processing" || !hasPreview
      ? "overview"
      : "preview"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl md:max-w-4xl"
        aria-describedby="source-overview-description"
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-8">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <FileIcon
                  size={18}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <DialogTitle className="truncate font-heading text-xl">
                  {filename}
                </DialogTitle>
              </div>
              <DialogDescription
                id="source-overview-description"
                className="text-xs text-muted-foreground"
              >
                {[
                  mimeType || "File",
                  formatSize(activeSource.sizeBytes),
                  formatDate(activeSource.createdAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </DialogDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>

              <Button asChild size="sm" className="min-h-9 gap-1.5 rounded-md">
                <a href={downloadUrl} download={filename}>
                  <ArrowDownIcon size={15} aria-hidden="true" />
                  <span>Download</span>
                </a>
              </Button>

              {onOpenDesktopFile && activeSource.relativeKey ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-9 gap-1.5 rounded-md"
                  onClick={() => onOpenDesktopFile(activeSource.relativeKey!)}
                  title="Open with system application"
                >
                  <ComputerIconComponent size={15} aria-hidden="true" />
                  <span className="hidden sm:inline">Open in app</span>
                </Button>
              ) : null}

              {onRevealDesktopFile && activeSource.relativeKey ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-9 gap-1.5 rounded-md"
                  onClick={() => onRevealDesktopFile(activeSource.relativeKey!)}
                  title="Reveal in Finder or Explorer"
                >
                  <FolderIcon size={15} aria-hidden="true" />
                  <span className="sr-only">Reveal file</span>
                </Button>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        {/* Processing and Retry State Alert */}
        {status === "failed" ||
        ingestionJob?.status === "failed" ||
        preparationJob?.status === "failed" ||
        retryError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/10 px-5 py-3 text-sm text-destructive sm:px-6">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Preparation failed</p>
              <p className="text-xs">
                {retryError ||
                  ingestionJob?.error ||
                  preparationJob?.error ||
                  activeSource.error ||
                  "This file could not be indexed for retrieval."}
              </p>
            </div>
            {onRetryIngestion ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-1.5"
                disabled={retrying}
                onClick={handleRetry}
              >
                {retrying ? (
                  <LoadingIcon className="animate-spin" size={14} />
                ) : (
                  <RotateLeftIcon size={14} />
                )}
                <span>{retrying ? "Retrying…" : "Retry processing"}</span>
              </Button>
            ) : null}
          </div>
        ) : status === "processing" ||
          ingestionJob?.status === "running" ||
          ingestionJob?.status === "queued" ||
          preparationJob?.status === "leased" ||
          preparationJob?.status === "queued" ? (
          <div className="border-b border-border/60 bg-muted/40 px-5 py-3 sm:px-6">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <LoadingIcon
                  className="animate-spin text-amber-500"
                  size={14}
                />
                {ingestionJob?.status === "queued" ||
                preparationJob?.status === "queued"
                  ? "Queued for processing…"
                  : "Preparing retrieval sections…"}
              </span>
              {progress !== undefined ? (
                <span>{Math.round(progress)}%</span>
              ) : null}
            </div>
            {progress !== undefined ? (
              <Progress
                value={progress}
                className="mt-2 h-1.5"
                aria-label={`Ingestion ${Math.round(progress)} percent complete`}
              />
            ) : null}
          </div>
        ) : unsupported ? (
          <div className="border-b border-border/60 bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground sm:px-6">
            This file is stored in your project but cannot be indexed for
            retrieval.
          </div>
        ) : null}

        {/* Content Tabs */}
        <Tabs
          defaultValue={defaultTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-border/60 px-5 sm:px-6">
            <TabsList
              className="h-10 p-1"
              aria-label="Source details and preview"
            >
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {hasPreview ? (
                <TabsTrigger value="preview">Preview</TabsTrigger>
              ) : null}
              {isPdf && activeSource.extractedText ? (
                <TabsTrigger value="extracted-text">Extracted text</TabsTrigger>
              ) : null}
            </TabsList>
          </div>

          {/* Overview Tab */}
          <TabsContent
            value="overview"
            className="mt-0 min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
          >
            <div className="space-y-5">
              {/* Document Summary */}
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Summary
                </h3>
                {activeSource.summary ? (
                  <p className="mt-1.5 rounded-lg border border-border/70 bg-muted/30 p-3.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                    {activeSource.summary}
                  </p>
                ) : status === "processing" ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    An AI summary will be generated once processing completes.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    No summary available for this source.
                  </p>
                )}
              </div>

              {/* Technical Specifications */}
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  File details
                </h3>
                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2.5 rounded-lg border border-border/70 p-3.5 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Filename</dt>
                    <dd className="mt-0.5 font-medium break-words text-foreground">
                      {filename}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="mt-0.5 font-medium text-foreground">
                      {statusInfo.label}
                    </dd>
                  </div>
                  {activeSource.sizeBytes ? (
                    <div>
                      <dt className="text-muted-foreground">File size</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {formatSize(activeSource.sizeBytes)} (
                        {activeSource.sizeBytes.toLocaleString()} bytes)
                      </dd>
                    </div>
                  ) : null}
                  {mimeType ? (
                    <div>
                      <dt className="text-muted-foreground">MIME type</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {mimeType}
                      </dd>
                    </div>
                  ) : null}
                  {activeSource.createdAt ? (
                    <div>
                      <dt className="text-muted-foreground">Date added</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {formatDate(activeSource.createdAt)}
                      </dd>
                    </div>
                  ) : null}
                  {activeSource.relativeKey ? (
                    <div>
                      <dt className="text-muted-foreground">Workspace key</dt>
                      <dd className="mt-0.5 font-mono break-all text-muted-foreground">
                        {activeSource.relativeKey}
                      </dd>
                    </div>
                  ) : null}
                  {activeSource.originalUrl ? (
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">Original URL</dt>
                      <dd className="mt-0.5 break-all">
                        <a
                          href={activeSource.originalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-brand underline underline-offset-4 hover:text-brand/80"
                        >
                          {activeSource.originalUrl}
                          <ArrowUpRightIcon size={12} aria-hidden="true" />
                        </a>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>

              {/* Indexed Retrieval Sections */}
              {citations.length ? (
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Indexed citations ({citations.length})
                  </h3>
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border/70 p-3 text-xs">
                    <ul className="space-y-1.5">
                      {citations.map((citation, index) => (
                        <li
                          key={index}
                          className="flex items-start gap-2 text-muted-foreground"
                        >
                          <CheckCircleIcon
                            size={14}
                            className="mt-0.5 shrink-0 text-emerald-500"
                            aria-hidden="true"
                          />
                          <div>
                            <span className="font-medium text-foreground">
                              {citation.label}
                            </span>
                            {citation.detail ? (
                              <span className="ml-1 text-muted-foreground">
                                ({citation.detail})
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          </TabsContent>

          {/* Preview Tab */}
          {hasPreview ? (
            <TabsContent
              value="preview"
              forceMount
              className="mt-0 min-h-0 flex-1 overflow-y-auto p-5 sm:p-6 data-[state=inactive]:hidden"
            >
              {isPdf && activeSource.relativeKey ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-end">
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="min-h-8 text-xs"
                    >
                      <a
                        href={inlinePreviewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ArrowUpRightIcon size={14} className="mr-1" />
                        Open in new tab
                      </a>
                    </Button>
                  </div>
                  <PdfReader url={inlinePreviewUrl} initialPage={1} quote="" />
                </div>
              ) : isImage ? (
                <div className="flex flex-col items-center justify-center p-4">
                  <Image
                    src={inlinePreviewUrl}
                    alt={filename}
                    width={800}
                    height={600}
                    unoptimized
                    className="max-h-[60vh] max-w-full rounded-md object-contain shadow-sm"
                  />
                </div>
              ) : isMarkdown && activeSource.extractedText ? (
                <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border/70 bg-card p-4 sm:p-6">
                  <Markdown text={activeSource.extractedText} />
                </div>
              ) : activeSource.extractedText ? (
                <div className="rounded-lg border border-border/70 bg-card p-4">
                  <pre className="max-h-[65vh] overflow-x-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
                    {activeSource.extractedText}
                  </pre>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileIcon
                    size={40}
                    className="text-muted-foreground/60"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm font-medium">
                    Preview not available
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use the download button above to inspect this file on your
                    device.
                  </p>
                </div>
              )}
            </TabsContent>
          ) : null}

          {/* Extracted Text Tab */}
          {isPdf && activeSource.extractedText ? (
            <TabsContent
              value="extracted-text"
              className="mt-0 min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
            >
              <div className="rounded-lg border border-border/70 bg-card p-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  This is the text extracted from the document used for AI study
                  generation and semantic search.
                </p>
                <pre className="max-h-[60vh] overflow-x-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
                  {activeSource.extractedText}
                </pre>
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
