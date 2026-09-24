/** Resolves the practice question route and starts immediate-feedback practice. */

import { StudySession } from "@/components/study-session/study-session"

/** Renders a project's question session with an optional topic filter. */
export default async function PracticeQuestionsPage({
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
