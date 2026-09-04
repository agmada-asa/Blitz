/** Resolves a project route and starts an immediate-feedback practice session. */

import { StudySession } from "@/components/study-session/study-session"

/** Renders the project practice mode with an optional topic filter. */
export default async function PracticePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ topicId?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  return (
    <StudySession
      projectId={projectId}
      mode="practice"
      topicId={query.topicId}
    />
  )
}
