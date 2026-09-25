/** Exposes a project's source-backed concept map at a shareable route. */

import { ProjectConceptMap } from "@/components/projects/project-concept-map"

/** Resolves the selected concept from Next.js 16 promise-based route inputs. */
export default async function ProjectMapPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ concept?: string }>
}) {
  const [{ projectId }, { concept }] = await Promise.all([params, searchParams])
  return <ProjectConceptMap projectId={projectId} selectedConceptId={concept} />
}
