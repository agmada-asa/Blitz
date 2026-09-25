"use client"

/** Connects project-scoped source data and existing source actions to a full page workspace. */

import Link from "next/link"
import { useEffect, useState } from "react"
import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import { ProjectFiles } from "@/components/projects/project-files"
import { SourceUploader } from "@/components/projects/source-uploader"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {} from "@/lib/client/desktop"

/** Props for the Sources route after its promise based parameters are resolved. */
type ProjectSourcesWorkspaceProps = {
  projectId: string
  initialResearchRequestId?: string
}

/** Shows current project sources, existing add methods, and source detail previews. */
export function ProjectSourcesWorkspace({
  projectId,
  initialResearchRequestId,
}: ProjectSourcesWorkspaceProps) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const {
    results: sources,
    status: sourceStatus,
    loadMore,
  } = usePaginatedQuery(
    api.sources.listSources,
    { projectId: convexProjectId },
    { initialNumItems: 20 }
  )
  const createSource = useMutation(api.sources.createSource)
  const updateSource = useMutation(api.sources.updateSource)
  const enqueueContent = useMutation(api.contentGeneration.enqueue)
  const setContentDepth = useMutation(api.contentGeneration.setDepth)
  const [agentWorkspaceDirectory, setAgentWorkspaceDirectory] = useState("")
  const [desktopAvailable, setDesktopAvailable] = useState(false)
  const ingestion = useQuery(api.projectAgents.listIngestion, {
    projectId: convexProjectId,
  })
  const preparation = useQuery(api.preparation.listJobsForProject, {
    projectId: convexProjectId,
    sourceIds: sources.map((source) => source._id),
  })
  const contentJobs = useQuery(api.contentGeneration.listForProject, {
    projectId: convexProjectId,
    sourceIds: sources.map((source) => source._id),
  })
  const artifacts = useQuery(api.projectAgents.listArtifacts, {
    projectId: convexProjectId,
  })

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) setDesktopAvailable(Boolean(window.blitzDesktop))
    })
    fetch(`/api/projects/${encodeURIComponent(projectId)}/agent`)
      .then(
        async (response) =>
          (await response.json()) as { workspaceDirectory?: string }
      )
      .then((result) => {
        if (active) setAgentWorkspaceDirectory(result.workspaceDirectory ?? "")
      })
      .catch(() => {
        if (active) setAgentWorkspaceDirectory("")
      })
    return () => {
      active = false
    }
  }, [projectId])

  /** Opens one generated file through the project's existing artifact endpoint. */
  function openArtifact(artifact: { relativeKey: string }): void {
    if (window.blitzDesktop) {
      const absolutePath = agentWorkspaceDirectory
        ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${artifact.relativeKey}`
        : artifact.relativeKey
      void window.blitzDesktop.openFile(projectId, absolutePath)
      return
    }
    window.open(
      `/api/projects/${encodeURIComponent(projectId)}/agent/artifacts?key=${encodeURIComponent(artifact.relativeKey)}`,
      "_blank",
      "noopener,noreferrer"
    )
  }

  /** Reveals one generated artifact in the desktop file browser when available. */
  function revealArtifact(artifact: { relativeKey: string }): void {
    if (!window.blitzDesktop) return
    const absolutePath = agentWorkspaceDirectory
      ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${artifact.relativeKey}`
      : artifact.relativeKey
    void window.blitzDesktop.revealFile(projectId, absolutePath)
  }

  /** Adds one project artifact through the existing explicit promotion endpoint. */
  async function addArtifactToSources(artifact: {
    relativeKey: string
  }): Promise<void> {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/agent/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativeKey: artifact.relativeKey }),
      }
    )
    const payload = (await response.json()) as { error?: string }
    if (!response.ok)
      throw new Error(payload.error || "File could not be added to sources.")
  }

  /** Retries source ingestion through the existing project-scoped recovery route. */
  async function retrySource(sourceId: string): Promise<void> {
    const response = await fetch("/api/sources/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, sourceId }),
    })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      throw new Error(payload.error || "Source retry failed.")
    }
  }

  if (project === undefined) return <SourcesLoadingState />
  if (!project) return <SourcesNotFoundState />

  const legacyJobs = preparation?.map((job) => ({
    jobId: String(job.jobId),
    sourceId: String(job.sourceId),
    status: job.status,
    error: job.error ?? undefined,
    nextChunkOrdinal: job.nextChunkOrdinal,
    totalChunks: job.totalChunks ?? undefined,
    generatedItemCount: job.generatedItemCount ?? undefined,
    leaseExpired: job.leaseExpired,
  }))
  const agentJobs = contentJobs?.map((job) => ({
    jobId: String(job.jobId),
    sourceId: String(job.sourceId),
    status: job.status,
    error: job.error ?? undefined,
    nextChunkOrdinal: job.importedPages,
    totalChunks: job.totalPages ?? undefined,
    leaseExpired: job.leaseExpired,
    stage: job.stage ?? undefined,
    isContentGeneration: true,
  })) ?? []
  const preparationJobs = [
    ...(legacyJobs ?? []).filter((job) => !agentJobs.some((agent) => agent.sourceId === job.sourceId)),
    ...agentJobs,
  ]

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-24 sm:px-7 sm:py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
            <Link href={`/projects/${encodeURIComponent(projectId)}`}>
              <span aria-hidden="true">←</span>
              <span className="ml-2">{project.title}</span>
            </Link>
          </Button>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Sources
          </h1>
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        <section className="min-w-0" aria-label="Project sources">
          {sourceStatus === "LoadingFirstPage" ? (
            <p className="py-5 text-sm text-muted-foreground" role="status">
              Loading sources…
            </p>
          ) : (
            <ProjectFiles
              projectId={convexProjectId}
              sources={sources}
              ingestion={ingestion?.map((job) => ({
                sourceId: String(job.sourceId),
                status: job.status,
                error: job.error,
              }))}
              preparation={preparationJobs}
              artifacts={artifacts?.map((artifact) => ({
                id: String(artifact._id),
                relativeKey: artifact.relativeKey,
                kind: artifact.kind,
                mimeType: artifact.mimeType,
                sizeBytes: artifact.sizeBytes,
                status: artifact.status,
                updatedAt: artifact.updatedAt,
              }))}
              actions={{
                onOpenArtifact: openArtifact,
                onRevealArtifact: desktopAvailable ? revealArtifact : undefined,
                onOpenCreatedFilesFolder:
                  desktopAvailable && agentWorkspaceDirectory
                    ? () =>
                        void window.blitzDesktop?.openFile(
                          projectId,
                          agentWorkspaceDirectory
                        )
                    : undefined,
                onAddArtifactToSources: addArtifactToSources,
                onRetryIngestion: retrySource,
              }}
            />
          )}
          {sourceStatus === "CanLoadMore" || sourceStatus === "LoadingMore" ? (
            <Button
              variant="outline"
              className="mt-4"
              disabled={sourceStatus === "LoadingMore"}
              onClick={() => loadMore(20)}
            >
              {sourceStatus === "LoadingMore"
                ? "Loading sources…"
                : "Load more"}
            </Button>
          ) : null}
        </section>

        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <SourceUploader
            projectId={convexProjectId}
            depth={project.contentDepth ?? 3}
            onDepthChange={(depth) => setContentDepth({ projectId: convexProjectId, depth })}
            initialResearchRequestId={initialResearchRequestId}
            createSource={createSource}
            updateSource={updateSource}
            enqueueContent={enqueueContent}
          />
        </aside>
      </div>
    </main>
  )
}

/** Keeps source navigation visible while the project query is pending. */
function SourcesLoadingState() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-7">
      <div role="status" aria-label="Loading sources">
        <span className="sr-only">Loading sources</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </main>
  )
}

/** Offers a simple return path when the requested project no longer exists. */
function SourcesNotFoundState() {
  return (
    <main className="mx-auto flex min-h-[55svh] max-w-3xl flex-col items-center justify-center px-5 text-center">
      <div role="alert">
        <h1 className="font-heading text-2xl font-semibold">
          Project not found
        </h1>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/library">Back to projects</Link>
        </Button>
      </div>
    </main>
  )
}
