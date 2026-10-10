/**
 * Retries marking an attempt's written answers after the grading run failed
 * or stopped. Returns at once and marks after the response with `after()`.
 */

import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { serverConvexClient } from "@/lib/server/convex"
import { requestId, runExamGrading } from "@/lib/server/exam"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because the run starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background run up to ten minutes. */
export const maxDuration = 600

/** Restarts marking for a submitted attempt. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to mark answers" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const attemptId = requestId(body?.attemptId) as Id<"examAttempts"> | null
  if (!attemptId) return Response.json({ error: "Choose an attempt" }, { status: 400 })
  try {
    const { gradingStartedAt } = await serverConvexClient().mutation(
      api.exam.restartGrading,
      { attemptId }
    )
    if (gradingStartedAt !== null) after(() => runExamGrading(attemptId, gradingStartedAt))
    return Response.json({ started: gradingStartedAt !== null })
  } catch {
    return Response.json(
      { error: "Marking could not be restarted. Try again." },
      { status: 503 }
    )
  }
}
