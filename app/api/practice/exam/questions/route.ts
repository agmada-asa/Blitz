/**
 * Saves the learner's edit to one question of an exam paper.
 *
 * The edit is checked here with `validateQuestionEdit` from `lib/exam.ts`,
 * the same rules that validate extracted and mock questions, because those
 * rules depend on modules Convex functions do not bundle. The validated
 * question is then saved with `exam.updateQuestion`, which re-checks its
 * bounds, refuses a paper that is being prepared or marked, keeps the
 * question's learning item in sync, and marks earlier attempts again.
 * Deleting a question or a paper needs no validation, so the editor calls
 * those mutations directly.
 */

import { ConvexError } from "convex/values"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { EXAM_CHANGE_LOCK_MESSAGES } from "@/lib/exam-scoring"
import { validateQuestionEdit } from "@/lib/exam"
import { serverConvexClient } from "@/lib/server/convex"
import { requestId } from "@/lib/server/exam"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js like the other exam routes, which share `lib/server/exam.ts`. */
export const runtime = "nodejs"

/** Message for failures the learner can only retry. */
const SAVE_ERROR = "The question could not be saved. Try again."

/**
 * Validates and saves one question edit.
 * @returns `{ saved: true }`, or `{ error }` with a learner-facing message:
 *   400 for an invalid edit or a change the paper refuses, 404 for a missing
 *   paper or question, 503 when saving failed.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to edit this paper" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const paperId = requestId(body?.paperId) as Id<"examPapers"> | null
  const questionId = requestId(body?.questionId)
  if (!paperId || !questionId)
    return Response.json({ error: "Choose a question to edit" }, { status: 400 })
  try {
    const client = serverConvexClient()
    const session = await client.query(api.exam.editorSession, { paperId })
    if (!session) return Response.json({ error: "This paper was deleted." }, { status: 404 })
    if (session.paper.changeLock)
      return Response.json(
        { error: EXAM_CHANGE_LOCK_MESSAGES[session.paper.changeLock] },
        { status: 400 }
      )
    const current = session.questions.find((question) => question.id === questionId)
    if (!current)
      return Response.json(
        { error: "This question was deleted. Reload the page to see the paper." },
        { status: 404 }
      )
    const result = validateQuestionEdit(
      {
        type: current.type,
        options: current.options,
        ...(current.answerSource ? { answerSource: current.answerSource } : {}),
      },
      body?.question,
      session.paper.kind,
      session.questions
        .filter((question) => question.id !== questionId)
        .map((question) => question.prompt)
    )
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
    await client.mutation(api.exam.updateQuestion, {
      paperId,
      questionId,
      question: result.question,
      ...(result.previousOptionIds ? { previousOptionIds: result.previousOptionIds } : {}),
    })
    return Response.json({ saved: true })
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === "string")
      return Response.json({ error: error.data }, { status: 400 })
    return Response.json({ error: SAVE_ERROR }, { status: 503 })
  }
}
