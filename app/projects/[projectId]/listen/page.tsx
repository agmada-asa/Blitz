"use client"

/** Loads project metadata and sources for the full-page Listen destination. */

import { use } from "react"
import { usePaginatedQuery, useQuery } from "convex/react"
import Link from "next/link"

import { PageContainer } from "@/components/page-container"
import { ProjectAudio } from "@/components/projects/project-audio"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** Resolves route parameters and renders Listen after project sources load. */
export default function ProjectListenPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = use(params)
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const { results: sources, status: sourceStatus } = usePaginatedQuery(
    api.sources.listSources,
    { projectId: convexProjectId },
    { initialNumItems: 20 }
  )

  if (project === undefined || sourceStatus === "LoadingFirstPage")
    return (
      <PageContainer className="space-y-5" aria-busy="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </PageContainer>
    )

  if (project === null)
    return (
      <PageContainer className="space-y-4">
        <h1 className="font-heading text-2xl font-medium">Project not found</h1>
        <Button asChild variant="outline">
          <Link href="/">Back to library</Link>
        </Button>
      </PageContainer>
    )

  return (
    <ProjectAudio
      projectId={projectId}
      projectTitle={project.title}
      sources={sources.map((source) => ({
        id: String(source._id),
        filename: source.filename,
        status: source.status,
      }))}
    />
  )
}
