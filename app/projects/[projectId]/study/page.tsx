/** Sends the retired study deck route to the project's Practice hub. */

import { redirect } from "next/navigation"

/** Redirects legacy study links into the current project learning choices. */
export default async function StudyPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ topicId?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  const topic = query.topicId
    ? `?topicId=${encodeURIComponent(query.topicId)}`
    : ""
  redirect(`/projects/${encodeURIComponent(projectId)}/practice${topic}`)
}
