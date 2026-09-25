"use client"

/** Resolves the project URL before rendering its live Sources workspace. */

import { use } from "react"
import { ProjectSourcesWorkspace } from "@/components/projects/project-sources-workspace"

/** Renders Sources for the project identified by this dynamic route. */
export default function ProjectSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ research?: string }>
}) {
  const { projectId } = use(params)
  const { research } = use(searchParams)
  return (
    <ProjectSourcesWorkspace
      projectId={projectId}
      initialResearchRequestId={research}
    />
  )
}
