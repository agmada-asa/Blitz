/** Resolves a project route and opens its deliberate written-answer activity. */

import { WrittenActivity } from "@/components/projects/written-activity"

/** Renders written activity for a project and optional topic. */
export default async function WritePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ topicId?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  return (
    <WrittenActivity
      key={`${projectId}:${query.topicId ?? ""}`}
      projectId={projectId}
      topicId={query.topicId}
    />
  )
}
