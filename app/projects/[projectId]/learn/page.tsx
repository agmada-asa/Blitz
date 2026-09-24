/** Exposes the project's source-grounded Learn experience at a focused route. */

import { ProjectLearn } from "@/components/projects/project-learn"

/** Resolves the Next.js 16 project segment and renders its Learn workspace. */
export default async function ProjectLearnPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ resume?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  const resume = query.resume === "1"
  return (
    <ProjectLearn
      key={resume ? "resume" : "path"}
      projectId={projectId}
      resume={resume}
    />
  )
}
