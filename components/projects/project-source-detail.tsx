"use client"

/**
 * Renders original source content, summary, and extracted text as a full page.
 * PDFs, slides and Word documents are drawn as the original; Markdown and text
 * are formatted from the extracted text.
 */

import dynamic from "next/dynamic"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useQuery } from "convex/react"
import { PageContainer } from "@/components/page-container"
import { formatSize } from "@/components/projects/source-list"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PdfReader } from "@/components/ui/pdf-reader"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Markdown } from "@/components/ui/markdown"
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  LoadingIcon,
  RotateLeftIcon,
} from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {} from "@/lib/client/desktop"
import { sourceDisplayName, sourceTypeLabel } from "@/lib/source-display"
import { originalViewer } from "@/lib/source-viewers"

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

/** Props identifying one source within its owning project. */
type ProjectSourceDetailProps = { projectId: string; sourceId: string }

/** Renders the selected source with live state and original, summary, and text views. */
export function ProjectSourceDetail({
  projectId,
  sourceId,
}: ProjectSourceDetailProps) {
  const projectIdValue = projectId as Id<"projects">
  const sourceIdValue = sourceId as Id<"sources">
  const project = useQuery(api.projects.getProject, {
    projectId: projectIdValue,
  })
  const source = useQuery(api.sources.getSource, {
    projectId: projectIdValue,
    sourceId: sourceIdValue,
  })
  const ingestion = useQuery(api.projectAgents.listIngestion, {
    projectId: projectIdValue,
  })
  const preparation = useQuery(api.preparation.listJobsForProject, {
    projectId: projectIdValue,
    sourceIds: [sourceIdValue],
  })
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState("")
  const [desktopAvailable, setDesktopAvailable] = useState(false)
  const [workspaceDirectory, setWorkspaceDirectory] = useState("")

  useEffect(() => {
    if (!window.blitzDesktop) return
    let active = true
    fetch(`/api/projects/${encodeURIComponent(projectId)}/agent`)
      .then(
        async (response) =>
          (await response.json()) as { workspaceDirectory?: string }
      )
      .then((result) => {
        if (active) setWorkspaceDirectory(result.workspaceDirectory ?? "")
      })
      .catch(() => {
        if (active) setWorkspaceDirectory("")
      })
      .finally(() => {
        if (active) setDesktopAvailable(true)
      })
    return () => {
      active = false
    }
  }, [projectId])

  /** Retries source ingestion and preserves the route when the request fails. */
  async function retrySource(): Promise<void> {
    if (retrying) return
    setRetrying(true)
    setRetryError("")
    try {
      const response = await fetch("/api/sources/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, sourceId }),
      })
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error || "Source retry failed.")
      }
    } catch (error) {
      setRetryError(
        error instanceof Error ? error.message : "Source retry failed."
      )
    } finally {
      setRetrying(false)
    }
  }

  if (project === undefined || source === undefined)
    return <SourceDetailLoading />
  if (!project || !source) return <SourceDetailNotFound projectId={projectId} />

  const ingestionJob = ingestion?.find(
    (job) => String(job.sourceId) === sourceId
  )
  const preparationJob = preparation?.find(
    (job) => String(job.sourceId) === sourceId
  )
  const needsAttention =
    source.status === "failed" ||
    ingestionJob?.status === "failed" ||
    preparationJob?.status === "failed" ||
    preparationJob?.leaseExpired
  const isBusy =
    source.status === "processing" ||
    ingestionJob?.status === "queued" ||
    ingestionJob?.status === "running" ||
    preparationJob?.status === "queued" ||
    preparationJob?.status === "leased"
  const statusLabel = needsAttention
    ? "Needs attention"
    : isBusy
      ? "Preparing"
      : source.unsupported && !preparationJob
        ? "Original saved"
        : "Ready"
  const downloadUrl = `/api/sources/file?projectId=${encodeURIComponent(projectId)}&sourceId=${encodeURIComponent(sourceId)}`
  const inlineUrl = `${downloadUrl}&inline=1`
  const isPdf = source.kind === "pdf" || source.mimeType === "application/pdf"
  const isMarkdown =
    source.kind === "markdown" || source.mimeType === "text/markdown"
  const isPlainText =
    source.kind === "text" ||
    source.kind === "paste" ||
    source.mimeType?.startsWith("text/plain")
  const relativeKey = source.relativeKey
  const revealLabel =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
      ? "Show in Finder"
      : "Show in folder"
  const name = sourceDisplayName(source.filename)
  // Slides and Word documents are drawn by the same readers the chat source pane uses.
  const viewer = originalViewer({
    mimeType: source.mimeType,
    filename: source.filename,
    fileUrl: source.relativeKey ? inlineUrl : undefined,
    textLength: source.extractedText?.length ?? 0,
  })
  const details = [
    sourceTypeLabel(source),
    formatSize(source.sizeBytes),
    source.createdAt
      ? `Added ${new Date(source.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <PageContainer>
      <header className="mb-6 space-y-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-3 min-h-9 max-w-full text-muted-foreground"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}/sources`}>
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            <span className="truncate">Sources</span>
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1
              title={name === source.filename ? undefined : source.filename}
              className="font-heading text-2xl font-medium tracking-tight break-words sm:text-3xl"
            >
              {name}
            </h1>
            {details ? (
              <p className="mt-1 text-sm text-muted-foreground">{details}</p>
            ) : null}
          </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Ready is the normal state, so only states that need a look get a badge. */}
          {statusLabel !== "Ready" ? (
            <Badge
              variant={
                needsAttention ? "destructive" : isBusy ? "outline" : "secondary"
              }
            >
              {statusLabel}
            </Badge>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <a href={downloadUrl} download={source.filename}>
              <ArrowDownIcon size={15} className="mr-1" />
              Download
            </a>
          </Button>
          {desktopAvailable && relativeKey ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void window.blitzDesktop?.openFile(projectId, relativeKey)
                }
              >
                Open in app
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const path = workspaceDirectory
                    ? `${workspaceDirectory.replace(/[\\/]$/, "")}/${relativeKey}`
                    : relativeKey
                  void window.blitzDesktop?.revealFile(projectId, path)
                }}
              >
                {revealLabel}
              </Button>
            </>
          ) : null}
        </div>
        </div>
      </header>

      {needsAttention ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p role="alert" className="text-sm">
            {retryError ||
              ingestionJob?.error ||
              preparationJob?.error ||
              source.error ||
              "This file could not be prepared."}
          </p>
          <Button
            className="mt-3"
            size="sm"
            disabled={retrying}
            onClick={() => void retrySource()}
          >
            {retrying ? (
              <LoadingIcon
                className="mr-2 animate-spin motion-reduce:animate-none"
                size={15}
              />
            ) : (
              <RotateLeftIcon className="mr-2" size={15} />
            )}
            Try again
          </Button>
        </div>
      ) : null}
      {source.unsupported ? (
        <p className="mb-4 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          The original is saved. Ask an agent to work with this file.
        </p>
      ) : null}

      <Tabs defaultValue="original" className="min-w-0">
        <TabsList className="grid h-auto w-full max-w-lg grid-cols-3">
          <TabsTrigger value="original">Original</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="text">Extracted text</TabsTrigger>
        </TabsList>
        <TabsContent value="original" className="mt-4 min-w-0">
          {isPdf && source.relativeKey ? (
            <PdfReader url={inlineUrl} initialPage={1} quote="" />
          ) : viewer === "slides" || viewer === "document" ? (
            // The readers scroll inside a fixed frame, like the PDF reader's pages.
            <div className="flex h-[75svh] min-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-card">
              {viewer === "slides" ? (
                <SlidesReader url={inlineUrl} quote="" />
              ) : (
                <DocumentReader url={inlineUrl} quote="" />
              )}
            </div>
          ) : isMarkdown && source.extractedText ? (
            <article className="max-w-4xl rounded-xl border border-border bg-card p-4 sm:p-7">
              <Markdown text={source.extractedText} />
            </article>
          ) : isPlainText && source.extractedText ? (
            <article className="max-w-4xl rounded-xl border border-border bg-card p-4 sm:p-7">
              <pre className="font-sans text-sm leading-7 break-words whitespace-pre-wrap">
                {source.extractedText}
              </pre>
            </article>
          ) : source.relativeKey ? (
            <iframe
              title={`Original ${source.filename}`}
              src={inlineUrl}
              className="h-[70svh] min-h-[420px] w-full rounded-xl border border-border bg-card"
            />
          ) : source.originalUrl ? (
            <a
              className="text-brand underline underline-offset-4"
              href={source.originalUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open original link
            </a>
          ) : (
            <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              Original preview is unavailable.
            </p>
          )}
        </TabsContent>
        <TabsContent value="summary" className="mt-4">
          <div className="max-w-4xl rounded-xl border border-border bg-card p-4 sm:p-7">
            {source.summary ? (
              <p className="text-sm leading-7 whitespace-pre-wrap">
                {source.summary}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No summary is available.
              </p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="text" className="mt-4">
          <article className="max-w-4xl rounded-xl border border-border bg-card p-4 sm:p-7">
            {source.extractedText ? (
              <pre className="overflow-x-auto font-sans text-sm leading-7 break-words whitespace-pre-wrap">
                {source.extractedText}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                {isBusy
                  ? "Text is being extracted."
                  : "No extracted text is available."}
              </p>
            )}
          </article>
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}

/** Keeps project context visible while the source query is loading. */
function SourceDetailLoading() {
  return (
    <PageContainer role="status">
      Loading source…
    </PageContainer>
  )
}

/** Offers a return path if this project or source no longer exists. */
function SourceDetailNotFound({ projectId }: { projectId: string }) {
  return (
    <PageContainer>
      <h1 className="font-heading text-2xl font-semibold">Source not found</h1>
      <Button asChild variant="outline" className="mt-4">
        <Link href={`/projects/${encodeURIComponent(projectId)}/sources`}>
          Back to sources
        </Link>
      </Button>
    </PageContainer>
  )
}
