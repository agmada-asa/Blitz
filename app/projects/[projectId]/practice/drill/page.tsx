/** Runs an adaptive drill for a module, or for one unit with `?unit=`. */

import { DrillSession } from "@/components/practice/drill-session"

/** Resolves route parameters and renders the drill. */
export default async function DrillPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ unit?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  return <DrillSession projectId={projectId} unitId={query.unit} />
}
