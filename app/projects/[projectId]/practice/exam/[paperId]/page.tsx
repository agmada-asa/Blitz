/** Shows one exam paper: its start screen, the timed paper, or an attempt's results with `?attempt=`. */

import { ExamSession } from "@/components/practice/exam-session"

/** Resolves the Next.js 16 route segments and renders the exam screen. */
export default async function ExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; paperId: string }>
  searchParams: Promise<{ attempt?: string }>
}) {
  const [{ projectId, paperId }, query] = await Promise.all([params, searchParams])
  return <ExamSession projectId={projectId} paperId={paperId} attemptId={query.attempt} />
}
