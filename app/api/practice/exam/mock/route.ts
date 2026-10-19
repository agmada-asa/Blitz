/**
 * Writes a mock exam paper from a module's chosen units.
 *
 * The route records the paper and returns at once; the paper is written
 * after the response with `after()`, in the style of the module's past
 * papers when there are any, and the Practice screen follows it through
 * Convex.
 */

import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { MOCK_EXAM_MINUTES, validateMockExamGuidance } from "@/lib/exam-scoring"
import { serverConvexClient } from "@/lib/server/convex"
import { requestId, runPaperPreparation } from "@/lib/server/exam"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because the run starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background run up to ten minutes. */
export const maxDuration = 600

/** Records a mock paper with optional bounded learner instructions and starts writing it. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to write a mock exam" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const projectId = requestId(body?.projectId)
  const unitIds = Array.isArray(body?.unitIds)
    ? body.unitIds.slice(0, 40).map(requestId)
    : []
  if (!projectId) return Response.json({ error: "Open a module first" }, { status: 400 })
  if (!unitIds.length || unitIds.some((id) => id === null))
    return Response.json({ error: "Choose at least one unit" }, { status: 400 })
  if (!(MOCK_EXAM_MINUTES as readonly unknown[]).includes(body?.minutes))
    return Response.json({ error: "Choose 30, 60, or 90 minutes" }, { status: 400 })
  let generationGuidance: string | undefined
  try {
    generationGuidance = validateMockExamGuidance(body?.generationGuidance)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Check the instructions and try again." },
      { status: 400 }
    )
  }
  try {
    const { paperId, runStartedAt } = await serverConvexClient().mutation(
      api.exam.createMockPaper,
      {
        projectId: projectId as Id<"projects">,
        unitIds: unitIds as Id<"units">[],
        minutes: body?.minutes as number,
        ...(generationGuidance ? { generationGuidance } : {}),
      }
    )
    if (runStartedAt !== null) after(() => runPaperPreparation(paperId, runStartedAt))
    return Response.json({ paperId, alreadyRunning: runStartedAt === null })
  } catch {
    return Response.json(
      { error: "The mock exam could not be started. Try again." },
      { status: 503 }
    )
  }
}
