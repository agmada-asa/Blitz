/** Opens the Teach session for one unit of a module. */

import { TeachSession } from "@/components/learn/teach-session"

/** Resolves the Next.js 16 unit segment and renders its Teach screen. */
export default async function UnitTeachPage({
  params,
}: {
  params: Promise<{ projectId: string; unitId: string }>
}) {
  const { unitId } = await params
  return <TeachSession unitId={unitId} />
}
