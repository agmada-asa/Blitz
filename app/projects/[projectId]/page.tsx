"use client"

/** Connects a project route to its source-grounded learning workspace. */

import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import Link from "next/link"
import { use, useEffect, useState } from "react"

import { ProjectActions } from "@/components/projects/project-actions"
import { ProjectAudio } from "@/components/projects/project-audio"
import { ProjectFiles } from "@/components/projects/project-files"
import { ProjectLearningWorkspace } from "@/components/projects/project-learning-workspace"
import { ResearchPanel } from "@/components/projects/research-panel"
import { SourceOverviewDialog } from "@/components/projects/source-overview-dialog"
import { SourceUploader } from "@/components/projects/source-uploader"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {} from "@/lib/client/desktop"

/** Renders one live project after resolving its Next.js 16 route parameters. */
export default function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ research?: string }>
}) {
  const { projectId } = use(params)
  const { research } = use(searchParams)
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const {
    results: sources,
    status: sourceStatus,
    loadMore: loadMoreSources,
  } = usePaginatedQuery(
    api.sources.listSources,
    {
      projectId: convexProjectId,
    },
    { initialNumItems: 20 }
  )
  const createSource = useMutation(api.sources.createSource)
  const createAndEnqueue = useMutation(api.sources.createAndEnqueue)
  const updateSource = useMutation(api.sources.updateSource)
  const enqueue = useMutation(api.preparation.enqueue)
  const [agentWorkspaceDirectory, setAgentWorkspaceDirectory] = useState("")
  const [overviewSourceId, setOverviewSourceId] = useState<string | null>(null)
  useEffect(() => {
    let active = true
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
  const ingestion = useQuery(api.projectAgents.listIngestion, {
    projectId: convexProjectId,
  })
  const preparation = useQuery(api.preparation.listJobsForProject, {
    projectId: convexProjectId,
    sourceIds: sources.map((source) => source._id),
  })
  const artifacts = useQuery(api.projectAgents.listArtifacts, {
    projectId: convexProjectId,
  })
  const citations = useQuery(api.projectAgents.listCitations, {
    projectId: convexProjectId,
  })

  /** Opens a generated file through the bounded local artifact endpoint. */
  const openArtifact = (artifact: { relativeKey: string }) => {
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

  /** Reveals a generated artifact in Finder when the Electron bridge is present. */
  const revealArtifact = (artifact: { relativeKey: string }) => {
    if (window.blitzDesktop) {
      const absolutePath = agentWorkspaceDirectory
        ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${artifact.relativeKey}`
        : artifact.relativeKey
      void window.blitzDesktop.revealFile(projectId, absolutePath)
    }
  }

  /** Promotes a text artifact through the explicit source approval route. */
  const addArtifactToSources = async (artifact: { relativeKey: string }) => {
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
      throw new Error(
        payload.error || "Artifact could not be added to sources."
      )
  }

  if (project === undefined) return <ProjectLoadingState />
  if (project === null) return <ProjectNotFoundState />

  const preparationJobs = preparation?.map((job) => ({
    jobId: String(job.jobId),
    sourceId: String(job.sourceId),
    status: job.status,
    error: job.error ?? undefined,
    nextChunkOrdinal: job.nextChunkOrdinal,
    totalChunks: job.totalChunks ?? undefined,
    generatedItemCount: job.generatedItemCount ?? undefined,
    leaseExpired: job.leaseExpired,
  }))

  const activeOverviewSource = overviewSourceId
    ? (sources.find(
        (candidate) => String(candidate._id) === overviewSourceId
      ) ?? null)
    : null

  return (
    <>
      <ProjectLearningWorkspace
        projectId={convexProjectId}
        projectTitle={project.title}
        sources={sources.map((source) => ({
          id: String(source._id),
          filename: source.filename,
          status: source.status,
        }))}
        onOpenSource={(sourceId) => {
          setOverviewSourceId(sourceId)
        }}
        headerActions={
          <>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" className="min-h-10 rounded-full">
                  Listen
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[88svh] overflow-y-auto sm:max-w-3xl">
                <DialogTitle className="sr-only">
                  Listen to this project
                </DialogTitle>
                <ProjectAudio
                  projectId={projectId}
                  sources={sources.map((source) => ({
                    id: String(source._id),
                    filename: source.filename,
                    status: source.status,
                  }))}
                />
              </DialogContent>
            </Dialog>
            <Button
              asChild
              variant="outline"
              className="hidden min-h-10 rounded-full sm:inline-flex"
            >
              <Link href={`/chat?projectId=${encodeURIComponent(projectId)}`}>
                Chat
              </Link>
            </Button>
            <div className="hidden sm:block">
              <ResearchPanel
                key={projectId}
                projectId={projectId}
                initialRequestId={research}
              />
            </div>
            <ProjectActions project={project} returnToLibrary />
          </>
        }
        sourceManager={
          <div className="pb-4">
            <SourceUploader
              projectId={convexProjectId}
              createSource={createSource}
              createAndEnqueue={createAndEnqueue}
              updateSource={updateSource}
              enqueue={enqueue}
            />

            {sourceStatus === "LoadingFirstPage" ? (
              <p className="mt-8 text-sm text-muted-foreground" role="status">
                Loading files…
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
                citations={citations?.map((citation) => ({
                  sourceId: String(citation.sourceId),
                  label: citation.label,
                  detail:
                    "detail" in citation && typeof citation.detail === "string"
                      ? citation.detail
                      : undefined,
                }))}
                actions={{
                  onOpenArtifact: openArtifact,
                  onAddArtifactToSources: addArtifactToSources,
                  onRetryIngestion: async (sourceId) => {
                    const response = await fetch("/api/sources/retry", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ projectId, sourceId }),
                    })
                    if (!response.ok) {
                      const payload = (await response.json()) as {
                        error?: string
                      }
                      throw new Error(payload.error || "Source retry failed.")
                    }
                  },
                  onOpenSource: (source) => {
                    setOverviewSourceId(String(source._id))
                  },
                  onRevealArtifact: revealArtifact,
                }}
              />
            )}
            {sourceStatus === "CanLoadMore" ||
            sourceStatus === "LoadingMore" ? (
              <Button
                variant="outline"
                className="mt-4"
                disabled={sourceStatus === "LoadingMore"}
                onClick={() => loadMoreSources(20)}
              >
                {sourceStatus === "LoadingMore"
                  ? "Loading files…"
                  : "Load more files"}
              </Button>
            ) : null}
          </div>
        }
      />

      <SourceOverviewDialog
        open={Boolean(overviewSourceId && activeOverviewSource)}
        onOpenChange={(open) => {
          if (!open) setOverviewSourceId(null)
        }}
        projectId={projectId}
        source={activeOverviewSource}
        ingestionJob={ingestion?.find(
          (job) => String(job.sourceId) === overviewSourceId
        )}
        preparationJob={preparationJobs?.find(
          (job) => job.sourceId === overviewSourceId
        )}
        citations={citations?.filter(
          (citation) => String(citation.sourceId) === overviewSourceId
        )}
        onRetryIngestion={async (sourceId) => {
          const response = await fetch("/api/sources/retry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, sourceId }),
          })
          if (!response.ok) {
            const payload = (await response.json()) as {
              error?: string
            }
            throw new Error(payload.error || "Source retry failed.")
          }
        }}
        onOpenDesktopFile={
          window.blitzDesktop
            ? (relativeKey) =>
                void window.blitzDesktop?.openFile(projectId, relativeKey)
            : undefined
        }
        onRevealDesktopFile={
          window.blitzDesktop
            ? (relativeKey) => {
                const absolutePath = agentWorkspaceDirectory
                  ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${relativeKey}`
                  : relativeKey
                void window.blitzDesktop?.revealFile(projectId, absolutePath)
              }
            : undefined
        }
      />
    </>
  )
}

/** Keeps the project route useful while its Convex project query is pending. */
function ProjectLoadingState() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <div role="status" aria-label="Loading project" className="space-y-10">
        <span className="sr-only">Loading project</span>
        <Skeleton className="h-5 w-28" />
        <div className="space-y-4">
          <Skeleton className="h-14 w-2/3 max-w-md" />
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </main>
  )
}

/** Explains that a stale or invalid project link no longer resolves. */
function ProjectNotFoundState() {
  return (
    <main className="mx-auto flex min-h-[60svh] w-full max-w-5xl flex-col items-center justify-center px-5 pb-28 text-center sm:px-8">
      <div role="alert">
        <h1 className="font-heading text-3xl">Project not found.</h1>
        <p className="mt-3 text-muted-foreground">
          That study project may have been removed or the link is out of date.
        </p>
        <Button asChild className="mt-7 rounded-full">
          <Link href="/library">Back to projects</Link>
        </Button>
      </div>
    </main>
  )
}
