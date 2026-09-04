/** Resolves a project route and starts a deferred-scoring test session. */

import { StudySession } from "@/components/study-session/study-session"

/** Renders the project test mode with an optional topic filter. */
export default async function TestPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ topicId?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  return (
    <StudySession projectId={projectId} mode="test" topicId={query.topicId} />
  )
}
