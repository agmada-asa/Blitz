/**
 * Shows one exam paper: its start screen, the timed paper, an attempt's
 * results with `?attempt=`, or the question editor with `?edit=1`.
 */

import { ExamEditor } from "@/components/practice/exam-editor"
import { ExamSession } from "@/components/practice/exam-session"

/** Resolves the Next.js 16 route segments and renders the exam screen or the question editor. */
export default async function ExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; paperId: string }>
  searchParams: Promise<{ attempt?: string; edit?: string }>
}) {
  const [{ projectId, paperId }, query] = await Promise.all([params, searchParams])
  if (query.edit === "1") return <ExamEditor projectId={projectId} paperId={paperId} />
  return <ExamSession projectId={projectId} paperId={paperId} attemptId={query.attempt} />
}
