"use client"

/** Renders a project's local file inventory, ingestion lifecycle, citations, and agent output. */

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  LoadingIcon,
  RotateLeftIcon,
  SparklesIcon,
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
  nextChunkOrdinal?: number
  totalChunks?: number
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

/** User-visible lifecycle record for a local agent task. */
export type ProjectAgentTask = {
  id: string
  title: string
  status: "queued" | "running" | "completed" | "failed"
  request?: string
  error?: string
  artifactIds?: string[]
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
  onAddArtifactToSources?: (artifact: ProjectArtifact) => void | Promise<void>
  onRetryIngestion?: (sourceId: string) => void | Promise<void>
}

/** Props for the project file browser. All derived collections are optional for old projects. */
export type ProjectFilesProps = {
  projectId: Id<"projects"> | string
  sources: ProjectFileSource[]
  ingestion?: ProjectFileIngestion[]
  artifacts?: ProjectArtifact[]
  agentTasks?: ProjectAgentTask[]
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
function sourceStatus(source: ProjectFileSource, ingestion: ProjectFileIngestion[]) {
  const job = ingestion.find((item) => item.sourceId === String(source._id))
  if (source.unsupported)
    return { label: "Unsupported file", variant: "outline" as const }
  if (job?.status === "failed" || source.status === "failed")
    return { label: "Needs attention", variant: "destructive" as const }
  if (job?.status === "running" || job?.status === "queued" || source.status === "processing")
    return { label: job?.status === "queued" ? "Queued" : "Ingesting", variant: "outline" as const }
  return { label: "Ready", variant: "secondary" as const }
}

/** Renders source and artifact states in one responsive project workspace panel. */
export function ProjectFiles({
  sources,
  ingestion = [],
  artifacts = [],
  agentTasks = [],
  citations = [],
  actions = {},
}: ProjectFilesProps) {
  const [busyArtifactId, setBusyArtifactId] = useState<string>()
  const activeArtifacts = artifacts.filter((artifact) => artifact.status === "active")
  const activeTasks = agentTasks.filter(
    (task) => task.status === "queued" || task.status === "running"
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

  return (
    <section className="mt-10 space-y-4" aria-labelledby="project-files-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="project-files-heading" className="font-heading text-2xl">
            Project files
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sources, generated work, and local agent activity in one place.
          </p>
        </div>
        {activeTasks.length ? (
          <Badge variant="outline" className="h-7 gap-1.5">
            <LoadingIcon className="animate-spin" size={14} aria-hidden="true" />
            {activeTasks.length} agent {activeTasks.length === 1 ? "task" : "tasks"} active
          </Badge>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
          <CardDescription>
            Uploaded files keep their ingestion state and retrieval citation together.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {sources.length ? (
            sources.map((source) => {
              const job = ingestion.find((item) => item.sourceId === String(source._id))
              const state = sourceStatus(source, ingestion)
              const citationCount = citations.filter(
                (citation) => citation.sourceId === String(source._id)
              ).length
              const sourceCitations = citations.filter(
                (citation) => citation.sourceId === String(source._id)
              )
              const progress =
                job?.totalChunks && job.totalChunks > 0
                  ? Math.min(100, (job.nextChunkOrdinal ?? 0) / job.totalChunks * 100)
                  : undefined
              return (
                <div
                  key={String(source._id)}
                  className="rounded-lg border border-border/70 p-3 sm:p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <FileIcon className="mt-0.5 shrink-0 text-muted-foreground" size={20} aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="break-words font-medium">{source.relativeKey || source.filename}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {[source.mimeType, formatSize(source.sizeBytes), citationCount ? `${citationCount} citation${citationCount === 1 ? "" : "s"}` : undefined]
                            .filter(Boolean)
                            .join(" · ") || "Local source"}
                        </p>
                      </div>
                    </div>
                    <Badge variant={state.variant}>{state.label}</Badge>
                  </div>
                  {progress !== undefined ? (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Preparing retrieval sections</span>
                        <span>{Math.round(progress)}%</span>
                      </div>
                      <Progress value={progress} aria-label={`Ingestion ${Math.round(progress)} percent complete`} />
                    </div>
                  ) : null}
                  {sourceCitations.length ? (
                    <div className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Retrieval citations:</span>{" "}
                      {sourceCitations.map((citation) => citation.detail ? `${citation.label} (${citation.detail})` : citation.label).join(" · ")}
                    </div>
                  ) : null}
                  {source.unsupported ? (
                    <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                      This file is available for agent inspection but cannot be indexed for retrieval yet.
                    </p>
                  ) : null}
                  {state.label === "Needs attention" ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      <span>{job?.error || source.error || "This file could not be prepared for retrieval."}</span>
                      {actions.onRetryIngestion ? (
                        <Button variant="outline" size="sm" onClick={() => void actions.onRetryIngestion?.(String(source._id))}>
                          <RotateLeftIcon size={14} /> Retry
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No source files yet. Upload a file above to make it available for retrieval.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Agent files</CardTitle>
            <CardDescription>
              Created files stay in the project workspace until you add one to sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeArtifacts.length ? (
              activeArtifacts.map((artifact) => (
                <div key={artifact.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {artifact.kind === "directory" ? <FolderIcon size={19} aria-hidden="true" /> : <FileIcon size={19} aria-hidden="true" />}
                    <span className="min-w-0 break-words text-sm font-medium">{artifact.relativeKey}</span>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 [&_button]:min-h-10">
                    {actions.onOpenArtifact ? (
                      <Button variant="ghost" size="sm" onClick={() => actions.onOpenArtifact?.(artifact)}>
                        <ArrowUpRightIcon size={15} /> Open
                      </Button>
                    ) : null}
                    {actions.onAddArtifactToSources && artifact.kind === "file" ? (
                      <Button size="sm" variant="outline" disabled={busyArtifactId === artifact.id} onClick={() => void addArtifact(artifact)}>
                        {busyArtifactId === artifact.id ? <LoadingIcon className="animate-spin" size={15} /> : <CheckCircleIcon size={15} />}
                        {busyArtifactId === artifact.id ? "Adding…" : "Add to sources"}
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

        <Card>
          <CardHeader>
            <CardTitle>Agent progress</CardTitle>
            <CardDescription>Recent work in this project workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {agentTasks.length ? (
              agentTasks.slice(0, 5).map((task) => (
                <div key={task.id} className="flex items-start gap-3">
                  <SparklesIcon className="mt-0.5 shrink-0 text-muted-foreground" size={17} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-words text-sm font-medium">{task.title}</p>
                    <Badge variant={task.status === "failed" ? "destructive" : task.status === "completed" ? "secondary" : "outline"}>
                        {task.status}
                      </Badge>
                    </div>
                    {task.error ? <p className="mt-1 text-xs text-destructive">{task.error}</p> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No agent tasks have been started for this project.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
