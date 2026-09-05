"use client"

/** Connects a project route to its sources, generation controls, and study action. */

import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import Link from "next/link"
import { use, useState } from "react"

import { ProjectActions } from "@/components/projects/project-actions"
import { ProjectFiles } from "@/components/projects/project-files"
import { ResearchPanel } from "@/components/projects/research-panel"
import { TopicList } from "@/components/projects/topic-list"
import { SourceUploader } from "@/components/projects/source-uploader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ArrowLeftIcon,
  BookOpenIcon,
  FileIcon,
  LayersIcon,
} from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

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
    status: sourcesStatus,
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
  const retryPreparation = useMutation(api.preparation.retry)
  const hasLearningItems = useQuery(api.learning.hasLearningItems, {
    projectId: convexProjectId,
  })

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

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-2xl">Sources</h2>
        </div>
        {sourcesStatus === "LoadingFirstPage" ? (
          <SourcesLoadingState />
        ) : !sources.length ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            <LayersIcon className="mx-auto mb-3" size={32} />
            Add a source to start preparing your learning feed.
          </div>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <SourceRow
                key={source._id}
                source={source}
                projectId={convexProjectId}
                retryPreparation={retryPreparation}
                prepareSource={() =>
                  enqueue({ projectId: convexProjectId, sourceId: source._id })
                }
              />
            ))}
            {sourcesStatus === "CanLoadMore" ||
            sourcesStatus === "LoadingMore" ? (
              <Button
                variant="outline"
                className="w-full"
                disabled={sourcesStatus === "LoadingMore"}
                onClick={() => loadMoreSources(20)}
              >
                {sourcesStatus === "LoadingMore"
                  ? "Loading sources…"
                  : "Load more sources"}
              </Button>
            ) : null}
          </div>
        )}
      </section>

      <ProjectFiles projectId={convexProjectId} sources={sources} />
    </main>
  )
}

/** Source status shape rendered by the project list. */
type SourceRowData = {
  _id: Id<"sources">
  filename: string
  originalUrl?: string
  status: "processing" | "ready" | "failed"
  summary?: string
  error?: string
}

/** Renders persisted source state plus live preparation progress when known. */
function SourceRow({
  source,
  projectId,
  retryPreparation,
  prepareSource,
}: {
  source: SourceRowData
  projectId: Id<"projects">
  prepareSource: () => Promise<unknown>
  retryPreparation: (input: {
    jobId: Id<"preparationJobs">
  }) => Promise<unknown>
}) {
  const jobs = useQuery(api.preparation.listJobsForProject, {
    projectId,
    sourceIds: [source._id],
  })
  const job = jobs?.[0]
  const preparationFailed = job?.status === "failed"
  const preparationComplete = job?.status === "completed"
  const noStudyContent = preparationComplete && job.generatedItemCount === 0
  const status =
    noStudyContent || preparationFailed
      ? "failed"
      : preparationComplete
        ? "ready"
        : source.status
  const detail = noStudyContent
    ? source.error || "No study content. Add clearer notes or another source."
    : preparationFailed
      ? job.error || undefined
      : job?.status === "leased"
        ? job.totalChunks
          ? `Preparing section ${Math.min(job.nextChunkOrdinal + 1, job.totalChunks)} of ${job.totalChunks}`
          : "Preparing source…"
        : source.status === "failed"
          ? source.error || undefined
          : undefined

  const [retryState, setRetryState] = useState<"idle" | "pending" | "error">(
    "idle"
  )
  const [retryError, setRetryError] = useState("")

  /** Queues an older source or retries failed preparation without replacing existing cards. */
  const retry = async () => {
    setRetryState("pending")
    setRetryError("")
    try {
      if (job) await retryPreparation({ jobId: job.jobId })
      else await prepareSource()
      setRetryState("idle")
    } catch (error) {
      setRetryState("error")
      setRetryError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Retry failed. Try again."
      )
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <FileIcon size={21} />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium">{source.filename}</p>
          {source.originalUrl ? (
            <a
              href={source.originalUrl}
              target="_blank"
              rel="noreferrer"
              className="block max-w-72 truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {source.originalUrl}
            </a>
          ) : null}
          {detail ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {detail}
            </p>
          ) : null}
          {retryError ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {retryError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 [&_button]:min-h-11">
        {preparationFailed || (!job && source.status === "ready") ? (
          <Button
            variant="outline"
            size="sm"
            disabled={retryState === "pending"}
            onClick={() => void retry()}
          >
            {retryState === "pending"
              ? "Queuing…"
              : job
                ? "Retry"
                : "Prepare feed"}
          </Button>
        ) : null}
        <Badge
          variant={
            status === "ready"
              ? "secondary"
              : status === "failed"
                ? "destructive"
                : "outline"
          }
        >
          {status}
        </Badge>
      </div>
    </div>
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

/** Shows source-shaped placeholders while a project's sources are loading. */
function SourcesLoadingState() {
  return (
    <div role="status" aria-label="Loading sources" className="space-y-3">
      <span className="sr-only">Loading sources</span>
      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex items-center gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
        >
          <Skeleton className="size-10 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  )
}
