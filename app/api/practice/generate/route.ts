/**
 * Writes a batch of exam-style practice questions for one unit.
 *
 * The route records a run and returns at once; the tutor writes the questions
 * after the response with `after()`, and the Practice screen follows the run
 * through Convex. Questions are validated with the lesson quiz rules before
 * they are saved, and invalid ones are dropped.
 */

import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { DEFAULT_BANK_BATCH, MAX_BANK_BATCH } from "@/lib/practice"
import { serverConvexClient } from "@/lib/server/convex"
import { runQuestionBank } from "@/lib/server/question-bank"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because the run starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background run up to ten minutes. */
export const maxDuration = 600

/** Starts a question-bank run for a unit and returns its ID immediately. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to write questions" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as {
    unitId?: unknown
    count?: unknown
  } | null
  if (typeof body?.unitId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(body.unitId))
    return Response.json({ error: "Choose a unit" }, { status: 400 })
  const count =
    typeof body.count === "number" && Number.isFinite(body.count)
      ? Math.max(1, Math.min(MAX_BANK_BATCH, Math.round(body.count)))
      : DEFAULT_BANK_BATCH
  const unitId = body.unitId as Id<"units">
  try {
    const { generationId, alreadyRunning } = await serverConvexClient().mutation(
      api.practice.startGeneration,
      { unitId, count }
    )
    if (!alreadyRunning) after(() => runQuestionBank(unitId, generationId, count))
    return Response.json({ generationId, alreadyRunning })
  } catch {
    return Response.json({ error: "Questions could not be started. Try again." }, { status: 503 })
  }
}
