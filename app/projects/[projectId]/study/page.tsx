import { StudyFeed } from "@/components/study/study-feed"

export default async function StudyPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  return <StudyFeed projectId={projectId} />
}
