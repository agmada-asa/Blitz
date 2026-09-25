"use client"

/** Shows the next learning action and the four live destinations for one project. */

import Link from "next/link"
import { usePaginatedQuery, useQuery } from "convex/react"

import { ProjectActions } from "@/components/projects/project-actions"
import { Button } from "@/components/ui/button"
import { ArrowLeftIcon, ArrowRightIcon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"

/** Renders project metadata first so an invalid ID does not start dependent queries. */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })

  if (project === undefined) {
    return (
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </main>
    )
  }
  if (project === null) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-8">
        <h1 className="text-2xl font-semibold">Project not found</h1>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/library">Back to library</Link>
        </Button>
      </main>
    )
  }
  return <LoadedProjectOverview project={project} />
}

/** Uses generated path and source status to choose the next useful live action. */
function LoadedProjectOverview({ project }: { project: Doc<"projects"> }) {
  const projectId = project._id
  const base = `/projects/${encodeURIComponent(String(projectId))}`
  const path = useQuery(api.learning.getProjectPath, { projectId })
  const { results: sources, status: sourceStatus } = usePaginatedQuery(
    api.sources.listSources,
    { projectId },
    { initialNumItems: 1 }
  )
  const loading = path === undefined || sourceStatus === "LoadingFirstPage"
  const concepts = path?.sections.flatMap((section) => section.concepts) ?? []
  const nextConcept =
    concepts.find(
      (concept) => concept.status !== "mastered" && concept.items.length > 0
    ) ?? concepts.find((concept) => concept.items.length > 0)
  const nextItem =
    nextConcept?.items.find((item) => item.type === "explain") ??
    nextConcept?.items[0]
  const progress = path?.stats.conceptCount
    ? Math.round(
        (path.stats.masteredConceptCount / path.stats.conceptCount) * 100
      )
    : 0
  const hasSources = sources.length > 0
  const onlyFailedSources =
    sourceStatus === "Exhausted" &&
    hasSources &&
    sources.every((source) => source.status === "failed")

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href="/library">
          <ArrowLeftIcon aria-hidden="true" /> Projects
        </Link>
      </Button>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 font-heading text-3xl font-semibold tracking-tight break-words sm:text-4xl">
          {project.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="min-h-10 rounded-full">
            <Link href={`${base}/map`}>Concept map</Link>
          </Button>
          <Button asChild variant="ghost" className="min-h-10 rounded-full">
            <Link
              href={`/chat?projectId=${encodeURIComponent(String(projectId))}`}
            >
              Ask Blitz
            </Link>
          </Button>
          <ProjectActions project={project} returnToLibrary />
        </div>
      </header>

      {loading ? (
        <section aria-label="Loading project" className="mt-8 space-y-5">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </section>
      ) : nextItem ? (
        <>
          <section className="mt-8 rounded-xl border border-brand/25 bg-brand/[0.04] p-5 sm:flex sm:items-center sm:justify-between sm:gap-5 sm:p-6">
            <h2 className="min-w-0 font-heading text-lg font-semibold break-words">
              {nextItem.title}
            </h2>
            <Button
              asChild
              className="mt-5 min-h-11 w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/85 sm:mt-0 sm:w-auto"
            >
              <Link href={`${base}/learn?resume=1`}>
                {progress === 100 ? "Review learning" : "Resume learning"}
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </section>

          {path && path.stats.conceptCount > 0 ? (
            <div className="mt-8 flex items-center gap-4">
              <span className="shrink-0 text-sm text-muted-foreground">
                {path.stats.masteredConceptCount} / {path.stats.conceptCount}{" "}
                concepts
              </span>
              <Progress
                value={progress}
                aria-label={`${path.stats.masteredConceptCount} of ${path.stats.conceptCount} concepts mastered`}
                className="[&_[data-slot=progress-indicator]]:bg-brand"
              />
            </div>
          ) : null}
        </>
      ) : (
        <section className="mt-8 rounded-xl border border-border bg-card p-6">
          <h2 className="font-heading text-xl font-semibold">
            {!hasSources
              ? "Add a source to start"
              : onlyFailedSources
                ? "Source needs attention"
                : "Preparing study material"}
          </h2>
          <Button asChild className="mt-5 min-h-11 rounded-full">
            <Link href={`${base}/sources`}>
              {!hasSources ? "Add a source" : "Open sources"}
            </Link>
          </Button>
        </section>
      )}

      {!loading ? (
        <nav
          aria-label="Project areas"
          className="mt-8 grid grid-cols-2 gap-3 xl:grid-cols-4"
        >
          <Destination href={`${base}/learn`} label="Learn" />
          <Destination href={`${base}/practice`} label="Practice" />
          <Destination href={`${base}/sources`} label="Sources" />
          <Destination href={`${base}/listen`} label="Listen" />
        </nav>
      ) : null}
    </main>
  )
}

/** Renders one boxed destination as a single accessible link. */
function Destination({ href, label }: { href: string; label: string }) {
  return (
    <Button
      asChild
      variant="outline"
      className="h-28 w-full flex-col items-stretch justify-between rounded-xl border-border bg-card p-4 text-left text-base hover:bg-muted"
    >
      <Link href={href}>
        <span>{label}</span>
        <ArrowRightIcon aria-hidden="true" className="self-end" />
      </Link>
    </Button>
  )
}
