/** Shows a module's Practice screen: the adaptive drill, exam prep, weak concepts, and question banks. */

import { PracticeHub } from "@/components/practice/practice-hub"

/** Resolves the Next.js 16 project segment and renders Practice. */
export default async function PracticePage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  return <PracticeHub projectId={projectId} />
}
