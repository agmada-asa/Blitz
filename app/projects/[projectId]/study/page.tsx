/** Resolves the dynamic project route and renders its interactive study feed. */

import { StudyFeed } from "@/components/study/study-feed"

/** Awaits the Next.js 16 route params and passes the project ID to the client feed. */
export default async function StudyPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  return <StudyFeed projectId={projectId} />
}
