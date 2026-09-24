/** Resolves a project URL and shows its live overview. */

import { ProjectOverview } from "@/components/projects/project-overview"

/** Awaits Next.js 16 route params before rendering the project overview. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  return <ProjectOverview projectId={projectId} />
}
