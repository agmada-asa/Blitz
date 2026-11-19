/**
 * Runs an adaptive drill for a project, for one unit with `?unit=`, or only
 * on weak topics with `?focus=weak`.
 */

import { DrillSession } from "@/components/practice/drill-session"

/** Resolves route parameters and renders the drill. */
export default async function DrillPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ unit?: string; focus?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  return (
    <DrillSession
      projectId={projectId}
      unitId={query.unit}
      focus={query.focus === "weak" ? "weak" : undefined}
    />
  )
}
