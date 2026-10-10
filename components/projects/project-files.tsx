"use client"

/** Renders a project's source inventory, ingestion lifecycle, and generated files. */

import { useState } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  LoadingIcon,
  RotateLeftIcon,
} from "@/components/ui/icon"
import type { Id } from "@/convex/_generated/dataModel"

/** The source fields needed by the file browser; extra Convex fields are intentionally ignored. */
export type ProjectFileSource = {
  _id: Id<"sources"> | string
  filename: string
  status: "processing" | "ready" | "failed"
  summary?: string
  error?: string
  relativeKey?: string
  mimeType?: string
  sizeBytes?: number
  originalUrl?: string
  unsupported?: boolean
  createdAt?: number
  extractedText?: string
  kind?: "pdf" | "markdown" | "text" | "paste"
}

/** Durable ingestion state associated with an uploaded source. */
export type ProjectFileIngestion = {
  sourceId: string
  status: "queued" | "running" | "completed" | "failed"
  error?: string
}

/** Durable study-preparation state associated with an uploaded source. */
export type ProjectFilePreparation = {
  jobId: string
  sourceId: string
  status: "queued" | "leased" | "failed" | "completed"
  error?: string | null
  nextChunkOrdinal?: number
  totalChunks?: number
  generatedItemCount?: number
  leaseExpired?: boolean
}

/** Agent-created file metadata; file contents remain in the local project workspace. */
export type ProjectArtifact = {
  id: string
  relativeKey: string
  kind: "file" | "directory"
  mimeType?: string
  sizeBytes?: number
  status: "active" | "deleted"
  unsupported?: boolean
  updatedAt?: number
}

/** Actions supplied by the desktop bridge or route integration for local artifacts. */
export type ProjectFilesActions = {
  onOpenArtifact?: (artifact: ProjectArtifact) => void
  onRevealArtifact?: (artifact: ProjectArtifact) => void
  onOpenCreatedFilesFolder?: () => void
  onAddArtifactToSources?: (artifact: ProjectArtifact) => void | Promise<void>
  onRetryIngestion?: (sourceId: string) => void | Promise<void>
}

/** Props for the project file browser. All derived collections are optional for old projects. */
export type ProjectFilesProps = {
  projectId: Id<"projects"> | string
  sources: ProjectFileSource[]
  ingestion?: ProjectFileIngestion[]
  preparation?: ProjectFilePreparation[]
  artifacts?: ProjectArtifact[]
  actions?: ProjectFilesActions
}

/** Formats byte sizes without exposing implementation details in the file list. */
export function formatSize(sizeBytes?: number): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return undefined
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Returns an accessible label and badge style for each source lifecycle state. */
function sourceStatus(
  source: ProjectFileSource,
  ingestion: ProjectFileIngestion[],
  preparation: ProjectFilePreparation[]
) {
  const ingestionJob = ingestion.find(
    (item) => item.sourceId === String(source._id)
  )
  const preparationJob = preparation.find(
    (item) => item.sourceId === String(source._id)
  )
  if (source.unsupported && !preparationJob)
    return { label: "Original saved", variant: "outline" as const }
  if (
    ingestionJob?.status === "failed" ||
    preparationJob?.status === "failed" ||
    preparationJob?.leaseExpired ||
    source.status === "failed"
  )
    return { label: "Needs attention", variant: "destructive" as const }
  if (ingestionJob?.status === "running" || ingestionJob?.status === "queued")
    return {
      label: ingestionJob.status === "queued" ? "Queued" : "Ingesting",
      variant: "outline" as const,
    }
  if (
    preparationJob?.status === "queued" ||
    preparationJob?.status === "leased"
  )
    return {
      label: preparationJob.status === "queued" ? "Queued" : "Preparing",
      variant: "outline" as const,
    }
  if (preparationJob?.status === "completed")
    return { label: "Ready", variant: "secondary" as const }
  if (source.status === "processing")
    return { label: "Preparing", variant: "outline" as const }
  return { label: "Ready", variant: "secondary" as const }
}

/** Returns the most useful recoverable error for a source row. */
function sourceError(
  source: ProjectFileSource,
  ingestionJob: ProjectFileIngestion | undefined,
  preparationJob: ProjectFilePreparation | undefined
): string | undefined {
  if (ingestionJob?.error) return ingestionJob.error
  if (preparationJob?.error) return preparationJob.error
  if (preparationJob?.leaseExpired)
    return "Preparation stopped before it finished. Retry to resume."
  return source.error
}

/** Returns preparation progress as a percentage when a chunk count is known. */
function preparationProgress(
  preparationJob: ProjectFilePreparation | undefined
): number | undefined {
  if (
    preparationJob?.status === "completed" ||
    preparationJob?.totalChunks === undefined ||
    preparationJob.totalChunks <= 0
  )
    return undefined
  return Math.min(
    100,
    ((preparationJob.nextChunkOrdinal ?? 0) / preparationJob.totalChunks) * 100
  )
}

/** Renders source and artifact states in one responsive project workspace panel. */
export function ProjectFiles({
  projectId,
  sources,
  ingestion = [],
  preparation = [],
  artifacts = [],
  actions = {},
}: ProjectFilesProps) {
  const [busyArtifactId, setBusyArtifactId] = useState<string>()
  const [artifactError, setArtifactError] = useState<{
    id: string
    message: string
  }>()
  const [retryingSourceId, setRetryingSourceId] = useState<string>()
  const [retryError, setRetryError] = useState<{
    sourceId: string
    message: string
  }>()
  const activeArtifacts = artifacts.filter(
    (artifact) => artifact.status === "active"
  )
  /** Adds one generated artifact to the source queue while keeping the action recoverable. */
  async function addArtifact(artifact: ProjectArtifact) {
    if (!actions.onAddArtifactToSources) return
    setBusyArtifactId(artifact.id)
    setArtifactError(undefined)
    try {
      await actions.onAddArtifactToSources(artifact)
    } catch (error) {
      setArtifactError({
        id: artifact.id,
        message:
          error instanceof Error ? error.message : "File could not be added.",
      })
    } finally {
      setBusyArtifactId(undefined)
    }
  }

  /** Retries one source and keeps request failures visible beside that source. */
  async function retrySource(sourceId: string): Promise<void> {
    if (!actions.onRetryIngestion) return
    setRetryingSourceId(sourceId)
    setRetryError(undefined)
    try {
      await actions.onRetryIngestion(sourceId)
    } catch (error) {
      setRetryError({
        sourceId,
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "The source could not be retried.",
      })
    } finally {
      setRetryingSourceId(undefined)
    }
  }

  const revealLabel =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
      ? "Show in Finder"
      : "Show in folder"

  return (
    <section className="space-y-5" aria-label="Sources and created files">
      <Card className="border-border bg-card">
        <CardContent className="p-5 sm:p-7">
          <h2 className="font-heading text-xl">Your sources</h2>
          <div className="mt-4 divide-y divide-border/70 rounded-xl border border-border">
            {sources.length ? (
              sources.map((source) => {
                const ingestionJob = ingestion.find(
                  (item) => item.sourceId === String(source._id)
                )
                const preparationJob = preparation.find(
                  (item) => item.sourceId === String(source._id)
                )
                const state = sourceStatus(source, ingestion, preparation)
                const progress = preparationProgress(preparationJob)
                return (
                  <div key={String(source._id)} className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <FileIcon
                          className="mt-0.5 shrink-0 text-muted-foreground"
                          size={20}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <Link
                            href={`/projects/${encodeURIComponent(String(projectId))}/sources/${encodeURIComponent(String(source._id))}`}
                            className="font-medium break-words hover:text-brand focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            {source.filename}
                          </Link>
                        </div>
                      </div>
                      <Badge variant={state.variant}>{state.label}</Badge>
                    </div>
                    {progress !== undefined ? (
                      <div className="mt-3 space-y-1.5">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Preparing study material</span>
                          <span>{Math.round(progress)}%</span>
                        </div>
                        <Progress
                          value={progress}
                          aria-label={`Preparation ${Math.round(progress)} percent complete`}
                        />
                      </div>
                    ) : null}
                    {source.unsupported && !preparationJob ? (
                      <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                        The original is saved. Blitz cannot read this file type yet.
                      </p>
                    ) : null}
                    {state.label === "Needs attention" ? (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        <span>
                          {sourceError(source, ingestionJob, preparationJob) ||
                            "This file could not be prepared for retrieval."}
                        </span>
                        {retryError?.sourceId === String(source._id) ? (
                          <span className="basis-full text-xs">
                            {retryError.message}
                          </span>
                        ) : null}
                        {actions.onRetryIngestion ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={retryingSourceId === String(source._id)}
                            onClick={() => void retrySource(String(source._id))}
                          >
                            {retryingSourceId === String(source._id) ? (
                              <LoadingIcon
                                className="animate-spin motion-reduce:animate-none"
                                size={14}
                              />
                            ) : (
                              <RotateLeftIcon size={14} />
                            )}
                            {retryingSourceId === String(source._id)
                              ? "Retrying…"
                              : "Retry"}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })
            ) : (
              <p className="p-5 text-sm text-muted-foreground">
                No sources yet.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-xl">Created files</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your agent may have created files for this project.
              </p>
            </div>
            {actions.onOpenCreatedFilesFolder ? (
              <Button
                variant="outline"
                size="sm"
                onClick={actions.onOpenCreatedFilesFolder}
              >
                <FolderIcon size={15} />{" "}
                {revealLabel === "Show in Finder"
                  ? "Open in Finder"
                  : "Open folder"}
              </Button>
            ) : null}
          </div>
          <div className="mt-4 space-y-2">
            {activeArtifacts.length ? (
              activeArtifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {artifact.kind === "directory" ? (
                      <FolderIcon size={19} aria-hidden="true" />
                    ) : (
                      <FileIcon size={19} aria-hidden="true" />
                    )}
                    <span className="min-w-0 text-sm font-medium break-words">
                      {artifact.relativeKey}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 [&_button]:min-h-10">
                    {actions.onOpenArtifact ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actions.onOpenArtifact?.(artifact)}
                      >
                        <ArrowUpRightIcon size={15} /> Open
                      </Button>
                    ) : null}
                    {actions.onRevealArtifact ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actions.onRevealArtifact?.(artifact)}
                      >
                        <FolderIcon size={15} /> {revealLabel}
                      </Button>
                    ) : null}
                    {actions.onAddArtifactToSources &&
                    artifact.kind === "file" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyArtifactId === artifact.id}
                        onClick={() => void addArtifact(artifact)}
                      >
                        {busyArtifactId === artifact.id ? (
                          <LoadingIcon className="animate-spin" size={15} />
                        ) : (
                          <CheckCircleIcon size={15} />
                        )}
                        {busyArtifactId === artifact.id
                          ? "Adding…"
                          : "Add to sources"}
                      </Button>
                    ) : null}
                  </div>
                  {artifactError?.id === artifact.id ? (
                    <p role="alert" className="w-full text-sm text-destructive">
                      {artifactError.message}
                    </p>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No created files yet.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
