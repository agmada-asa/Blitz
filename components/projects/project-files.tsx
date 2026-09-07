"use client"

/** Renders a project's local file inventory, ingestion lifecycle, citations, and agent output. */

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

/** Citation metadata shown beside a retrieval result or prepared source. */
export type ProjectFileCitation = {
  sourceId: string
  label: string
  detail?: string
}

/** Actions supplied by the desktop bridge or route integration for local artifacts. */
export type ProjectFilesActions = {
  onOpenArtifact?: (artifact: ProjectArtifact) => void
  onRevealArtifact?: (artifact: ProjectArtifact) => void
  onOpenSource?: (source: ProjectFileSource) => void
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
  citations?: ProjectFileCitation[]
  actions?: ProjectFilesActions
}

/** Formats byte sizes without exposing implementation details in the file list. */
function formatSize(sizeBytes?: number): string | undefined {
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
  if (source.unsupported)
    return { label: "Unsupported file", variant: "outline" as const }
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
  sources,
  ingestion = [],
  preparation = [],
  artifacts = [],
  citations = [],
  actions = {},
}: ProjectFilesProps) {
  const [busyArtifactId, setBusyArtifactId] = useState<string>()
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
    try {
      await actions.onAddArtifactToSources(artifact)
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

  return (
    <section
      className="mt-10 space-y-4"
      aria-labelledby="project-files-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="project-files-heading" className="font-heading text-2xl">
            Project files
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Original sources and generated files.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>
            Check preparation status and open your originals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {sources.length ? (
            sources.map((source) => {
              const ingestionJob = ingestion.find(
                (item) => item.sourceId === String(source._id)
              )
              const preparationJob = preparation.find(
                (item) => item.sourceId === String(source._id)
              )
              const state = sourceStatus(source, ingestion, preparation)
              const citationCount = citations.filter(
                (citation) => citation.sourceId === String(source._id)
              ).length
              const sourceCitations = citations.filter(
                (citation) => citation.sourceId === String(source._id)
              )
              const progress = preparationProgress(preparationJob)
              return (
                <div
                  key={String(source._id)}
                  className="rounded-lg border border-border/70 p-3 sm:p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <FileIcon
                        className="mt-0.5 shrink-0 text-muted-foreground"
                        size={20}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="font-medium break-words">
                          {source.relativeKey || source.filename}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {[
                            source.mimeType,
                            formatSize(source.sizeBytes),
                            citationCount
                              ? `${citationCount} citation${citationCount === 1 ? "" : "s"}`
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Local source"}
                        </p>
                      </div>
                    </div>
                    <Badge variant={state.variant}>{state.label}</Badge>
                  </div>
                  {actions.onOpenSource ? (
                    <div className="mt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actions.onOpenSource?.(source)}
                      >
                        <ArrowUpRightIcon size={15} /> Open original file
                      </Button>
                    </div>
                  ) : null}
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
                  {sourceCitations.length ? (
                    <div className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Retrieval citations:
                      </span>{" "}
                      {sourceCitations
                        .map((citation) =>
                          citation.detail
                            ? `${citation.label} (${citation.detail})`
                            : citation.label
                        )
                        .join(" · ")}
                    </div>
                  ) : null}
                  {source.unsupported ? (
                    <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                      This file is available for agent inspection but cannot be
                      indexed for retrieval yet.
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
            <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No source files yet. Upload a file above to make it available for
              retrieval.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Agent files</CardTitle>
            <CardDescription>
              Created files stay in the project workspace until you add one to
              sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
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
                        <FolderIcon size={15} /> Reveal
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
                </div>
              ))
            ) : (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                Generated files will appear here when an agent creates them.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
