/** Keeps old Learn links working; a module's learning path lives on its project page. */

import { redirect } from "next/navigation"

/** Sends `/projects/[projectId]/learn` to the project page, which lists its units. */
export default async function ProjectLearnPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  redirect(`/projects/${encodeURIComponent(projectId)}`)
}
