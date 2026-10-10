/**
 * Submits an exam attempt.
 *
 * Convex saves the final answers and marks choice questions in the same
 * mutation, so the browser never marks its own paper. After the response,
 * each answered choice question is recorded as study evidence with
 * `learning.recordAnswerEvent`, and written answers are marked in one
 * background provider run. The exam screen follows marking through Convex.
 */

import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { MAX_PAPER_QUESTIONS, MAX_WRITTEN_ANSWER_CHARS, type ExamAnswer } from "@/lib/exam-scoring"
import { serverConvexClient } from "@/lib/server/convex"
import { recordExamEvidence, requestId, runExamGrading } from "@/lib/server/exam"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because grading starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background grading run up to ten minutes. */
export const maxDuration = 600

/** Parses the untrusted answers list into bounded answers; Convex checks them against the paper. */
function parseAnswers(value: unknown): ExamAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const answers: ExamAnswer[] = []
  for (const raw of value.slice(0, MAX_PAPER_QUESTIONS)) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.questionId !== "string" || !/^q\d{1,3}$/.test(entry.questionId)) continue
    const selected = Array.isArray(entry.selectedOptionIds)
      ? entry.selectedOptionIds
          .slice(0, 8)
          .filter((id): id is string => typeof id === "string" && id.length <= 8)
      : undefined
    answers.push({
      questionId: entry.questionId,
      ...(selected ? { selectedOptionIds: selected } : {}),
      ...(typeof entry.text === "string"
        ? { text: entry.text.slice(0, MAX_WRITTEN_ANSWER_CHARS) }
        : {}),
    })
  }
  return answers
}

/** Submits an attempt and starts recording evidence and marking written answers. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to submit your paper" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const attemptId = requestId(body?.attemptId) as Id<"examAttempts"> | null
  if (!attemptId) return Response.json({ error: "Start the paper first" }, { status: 400 })
  const answers = parseAnswers(body?.answers)
  try {
    const result = await serverConvexClient().mutation(api.exam.submitAttempt, {
      attemptId,
      ...(answers ? { answers } : {}),
      auto: body?.auto === true,
    })
    after(async () => {
      await recordExamEvidence(attemptId, result.projectId, result.submittedAt, result.evidence)
      if (result.gradingStartedAt !== null)
        await runExamGrading(attemptId, result.gradingStartedAt)
    })
    return Response.json({ attemptId })
  } catch {
    return Response.json(
      { error: "Your paper could not be submitted. Your answers are still here; try again." },
      { status: 503 }
    )
  }
}
