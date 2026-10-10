/** Opens the Teach session for one unit of a module. */

import { TeachSession } from "@/components/learn/teach-session"

/**
 * Resolves the Next.js 16 unit segment and renders its Teach screen. An `ask`
 * query parameter (sent by Practice's Relearn action) is posted to the tutor
 * once the session is ready.
 */
export default async function UnitTeachPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; unitId: string }>
  searchParams: Promise<{ ask?: string }>
}) {
  const [{ unitId }, query] = await Promise.all([params, searchParams])
  return <TeachSession unitId={unitId} ask={query.ask} />
}
