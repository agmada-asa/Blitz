/**
 * Retries preparing an exam paper whose last run failed or stopped: reading
 * a past paper's questions again, or writing a mock paper again. Returns at
 * once and runs the work after the response with `after()`.
 */

import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { serverConvexClient } from "@/lib/server/convex"
import { requestId, runPaperPreparation } from "@/lib/server/exam"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because the run starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background run up to ten minutes. */
export const maxDuration = 600

/** Restarts a failed paper's run. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to retry" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const paperId = requestId(body?.paperId) as Id<"examPapers"> | null
  if (!paperId) return Response.json({ error: "Choose a paper" }, { status: 400 })
  try {
    const { runStartedAt } = await serverConvexClient().mutation(api.exam.restartPaper, {
      paperId,
    })
    if (runStartedAt !== null) after(() => runPaperPreparation(paperId, runStartedAt))
    return Response.json({ started: runStartedAt !== null })
  } catch {
    return Response.json({ error: "The paper could not be retried. Try again." }, { status: 503 })
  }
}
