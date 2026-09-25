"use client"

/** Resolves source route parameters and renders its full page detail. */

import { use } from "react"
import { ProjectSourceDetail } from "@/components/projects/project-source-detail"

/** Renders a source detail page from its project and source identifiers. */
export default function ProjectSourcePage({
  params,
}: {
  params: Promise<{ projectId: string; sourceId: string }>
}) {
  const { projectId, sourceId } = use(params)
  return <ProjectSourceDetail projectId={projectId} sourceId={sourceId} />
}
