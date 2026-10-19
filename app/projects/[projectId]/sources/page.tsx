"use client"

/**
 * Resolves the project URL before rendering its live Sources workspace.
 * `?research=` reopens a research request; `?unit=` picks the unit approved
 * research is added to, when Find sources was opened from a unit.
 */

import { use } from "react"
import { ProjectSourcesWorkspace } from "@/components/projects/project-sources-workspace"

/** Renders Sources for the project identified by this dynamic route. */
export default function ProjectSourcesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ research?: string; unit?: string }>
}) {
  const { projectId } = use(params)
  const { research, unit } = use(searchParams)
  return (
    <ProjectSourcesWorkspace
      projectId={projectId}
      initialResearchRequestId={research}
      initialResearchUnitId={unit}
    />
  )
}
