"use client"

/** Renders a project's sources, grouped by unit, and the files its agent created. */

import { useState } from "react"

import { SourceList } from "@/components/projects/source-list"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  FileIcon,
  FolderIcon,
  LoadingIcon,
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
  /** Where the file sits in the module; files without one are listed as not in a unit. */
  placement?:
    | { kind: "unit"; unitId: Id<"units"> | string }
    | { kind: "reference" }
    | { kind: "exam" }
    | { kind: "unsorted" }
}

/** A unit of the module, in learning-path order, used to group and move files. */
export type ProjectFileUnit = { id: Id<"units"> | string; title: string }

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
  units?: ProjectFileUnit[]
  ingestion?: ProjectFileIngestion[]
  preparation?: ProjectFilePreparation[]
  artifacts?: ProjectArtifact[]
  actions?: ProjectFilesActions
}

/** Renders source and artifact states in one responsive project workspace panel. */
export function ProjectFiles({
  projectId,
  sources,
  units = [],
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

  const revealLabel =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)
      ? "Show in Finder"
      : "Show in folder"

  return (
    <section className="space-y-5" aria-label="Sources and created files">
      <Card className="border-border bg-card">
        <CardContent className="p-5 sm:p-7">
          <h2 className="font-heading text-xl">Your sources</h2>
          <SourceList
            projectId={String(projectId)}
            sources={sources}
            units={units}
            ingestion={ingestion}
            preparation={preparation}
            onRetryIngestion={actions.onRetryIngestion}
          />
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
