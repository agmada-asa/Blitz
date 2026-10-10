"use client"

/** Renders original source content, summary, and extracted text as a full page. */

import Link from "next/link"
import { useEffect, useState } from "react"
import { useQuery } from "convex/react"
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

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-24 sm:px-7 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
            <Link href={`/projects/${encodeURIComponent(projectId)}/sources`}>
              <ArrowLeftIcon size={15} className="mr-2" />
              Sources
            </Link>
          </Button>
          <h1 className="font-heading text-2xl font-semibold tracking-tight break-words sm:text-3xl">
            {source.filename}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              needsAttention ? "destructive" : isBusy ? "outline" : "secondary"
            }
          >
            {statusLabel}
          </Badge>
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
    </main>
  )
}

/** Keeps project context visible while the source query is loading. */
function SourceDetailLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8" role="status">
      Loading source…
    </main>
  )
}

/** Offers a return path if this project or source no longer exists. */
function SourceDetailNotFound({ projectId }: { projectId: string }) {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-heading text-2xl font-semibold">Source not found</h1>
      <Button asChild variant="outline" className="mt-4">
        <Link href={`/projects/${encodeURIComponent(projectId)}/sources`}>
          Back to sources
        </Link>
      </Button>
    </main>
  )
}
