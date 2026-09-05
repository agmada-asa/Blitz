"use client"

/** Connects a project route to its sources, generation controls, and study action. */

import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import Link from "next/link"
import { use, useEffect, useState } from "react"

import { ProjectActions } from "@/components/projects/project-actions"
import { ProjectFiles } from "@/components/projects/project-files"
import { ResearchPanel } from "@/components/projects/research-panel"
import { TopicList } from "@/components/projects/topic-list"
import { SourceUploader } from "@/components/projects/source-uploader"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowLeftIcon, BookOpenIcon } from "@/components/ui/icon"
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
  const hasLearningItems = useQuery(api.learning.hasLearningItems, {
    projectId: convexProjectId,
  })
  const [agentCapability, setAgentCapability] = useState<{
    available: boolean
    error?: string
  }>()
  useEffect(() => {
    let active = true
    fetch(`/api/projects/${encodeURIComponent(projectId)}/agent`)
      .then(
        async (response) =>
          (await response.json()) as { available?: boolean; error?: string }
      )
      .then((result) => {
        if (active)
          setAgentCapability({
            available: result.available === true,
            error: result.error,
          })
      })
      .catch(() => {
        if (active)
          setAgentCapability({
            available: false,
            error: "The local agent is unavailable on this desktop.",
          })
      })
    return () => {
      active = false
    }
  }, [projectId])
  const ingestion = useQuery(api.projectAgents.listIngestion, {
    projectId: convexProjectId,
  })
  const artifacts = useQuery(api.projectAgents.listArtifacts, {
    projectId: convexProjectId,
  })
  const agentTasks = useQuery(api.projectAgents.listTasks, {
    projectId: convexProjectId,
  })
  const citations = useQuery(api.projectAgents.listCitations, {
    projectId: convexProjectId,
  })

  /** Starts a local project task through the desktop agent bridge. */
  const startAgent = async (input: { title: string; request: string }) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/agent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }
    )
    const payload = (await response.json()) as { error?: string }
    if (!response.ok)
      throw new Error(payload.error || "Agent task could not start.")
  }

  /** Opens a generated file through the bounded local artifact endpoint. */
  const openArtifact = (artifact: { relativeKey: string }) => {
    if (window.blitzDesktop) {
      void window.blitzDesktop.openFile(projectId, artifact.relativeKey)
      return
    }
    window.open(
      `/api/projects/${encodeURIComponent(projectId)}/agent/artifacts?key=${encodeURIComponent(artifact.relativeKey)}`,
      "_blank",
      "noopener,noreferrer"
    )
  }

  /** Opens an original source in the native shell or the bounded browser route. */
  const openSource = (source: {
    _id: Id<"sources"> | string
    relativeKey?: string
  }) => {
    if (source.relativeKey && window.blitzDesktop) {
      void window.blitzDesktop.openFile(projectId, source.relativeKey)
      return
    }
    window.open(
      `/api/sources/file?projectId=${encodeURIComponent(projectId)}&sourceId=${encodeURIComponent(String(source._id))}`,
      "_blank",
      "noopener,noreferrer"
    )
  }

  /** Reveals a generated artifact in Finder when the Electron bridge is present. */
  const revealArtifact = (artifact: { relativeKey: string }) => {
    if (window.blitzDesktop)
      void window.blitzDesktop.revealFile(projectId, artifact.relativeKey)
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

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 pb-28 font-sans sm:px-8 sm:py-12">
      <Link
        href="/library"
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon size={16} /> All projects
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="font-heading text-3xl font-medium tracking-tight break-words sm:text-4xl">
            {project?.title || "Loading…"}
          </h1>
        </div>
        <ProjectActions project={project} returnToLibrary />
        <div className="flex w-full flex-wrap gap-2 [&_a]:min-h-11 [&_button]:min-h-11">
          <ResearchPanel
            key={projectId}
            projectId={projectId}
            initialRequestId={research}
          />
          {hasLearningItems ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="rounded-full">
                    Study
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/projects/${encodeURIComponent(projectId)}/practice`}
                    >
                      Quick questions
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/projects/${encodeURIComponent(projectId)}/write`}
                    >
                      Written answers
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button asChild variant="outline" className="rounded-full">
                <Link href={`/projects/${encodeURIComponent(projectId)}/test`}>
                  Test
                </Link>
              </Button>
              <Button
                asChild
                className="rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
              >
                <Link href={`/?projectId=${encodeURIComponent(projectId)}`}>
                  <BookOpenIcon size={18} /> Open feed
                </Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <TopicList projectId={convexProjectId} />

      <div className="mt-10">
        <SourceUploader
          projectId={convexProjectId}
          createSource={createSource}
          createAndEnqueue={createAndEnqueue}
          updateSource={updateSource}
          enqueue={enqueue}
        />
      </div>

      {sourceStatus === "LoadingFirstPage" ? (
        <p role="status">Loading files…</p>
      ) : (
        <ProjectFiles
          projectId={convexProjectId}
          sources={sources}
          ingestion={ingestion?.map((job) => ({
            sourceId: String(job.sourceId),
            status: job.status,
            error: job.error,
          }))}
          artifacts={artifacts?.map((artifact) => ({
            id: String(artifact._id),
            relativeKey: artifact.relativeKey,
            kind: artifact.kind,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            status: artifact.status,
            updatedAt: artifact.updatedAt,
          }))}
          agentTasks={agentTasks?.map((task) => ({
            id: String(task._id),
            title: task.title,
            status: task.status,
            request: task.request,
            error: task.error,
            artifactIds: task.artifactIds?.map(String),
          }))}
          citations={citations?.map((citation) => ({
            sourceId: String(citation.sourceId),
            label: citation.label,
            detail:
              "detail" in citation && typeof citation.detail === "string"
                ? citation.detail
                : undefined,
          }))}
          agentAvailable={agentCapability?.available === true}
          agentUnavailableReason={agentCapability?.error}
          actions={{
            onStartAgent: startAgent,
            onOpenArtifact: openArtifact,
            onAddArtifactToSources: addArtifactToSources,
            onRetryIngestion: async (sourceId) => {
              const response = await fetch("/api/sources/retry", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectId, sourceId }),
              })
              if (!response.ok) {
                const payload = (await response.json()) as { error?: string }
                throw new Error(payload.error || "Source retry failed.")
              }
            },
            onOpenSource: openSource,
            onRevealArtifact: revealArtifact,
          }}
        />
      )}
      {sourceStatus === "CanLoadMore" || sourceStatus === "LoadingMore" ? (
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
    </main>
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
