/**
 * Adds an uploaded past paper to a module's exam prep.
 *
 * The browser first uploads the paper (and optional solutions or mark
 * scheme) through `POST /api/sources/upload` without a unit, so it is stored
 * and extracted like any source but never taught. This route records the
 * paper and returns at once; the questions are extracted after the response
 * with `after()`, and the Practice screen follows the paper through Convex.
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

/** Records a past paper and starts extracting its questions. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to add a past paper" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const projectId = requestId(body?.projectId)
  const sourceId = requestId(body?.sourceId)
  const solutionsSourceId =
    body?.solutionsSourceId === undefined || body.solutionsSourceId === null
      ? null
      : requestId(body.solutionsSourceId)
  if (!projectId || !sourceId || (body?.solutionsSourceId && !solutionsSourceId))
    return Response.json({ error: "Upload a paper first" }, { status: 400 })
  try {
    const { paperId, runStartedAt } = await serverConvexClient().mutation(
      api.exam.createPastPaper,
      {
        projectId: projectId as Id<"projects">,
        sourceId: sourceId as Id<"sources">,
        ...(solutionsSourceId ? { solutionsSourceId: solutionsSourceId as Id<"sources"> } : {}),
      }
    )
    if (runStartedAt !== null) after(() => runPaperPreparation(paperId, runStartedAt))
    return Response.json({ paperId, started: runStartedAt !== null })
  } catch {
    return Response.json(
      { error: "The paper could not be added. Try again." },
      { status: 503 }
    )
  }
}
