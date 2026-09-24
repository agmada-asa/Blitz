/** Opens a dedicated player and timed transcript for one project recording. */

import { ListeningRoom } from "@/components/projects/listening-room"

/** Resolves Next route parameters and renders the client-side listening controls. */
export default async function ProjectListeningPage({
  params,
}: {
  params: Promise<{ projectId: string; audioId: string }>
}) {
  const { projectId, audioId } = await params
  return <ListeningRoom projectId={projectId} audioId={audioId} />
}
