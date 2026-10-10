/**
 * Enqueues explicitly approved source indexes from a stored research proposal,
 * filed into the unit the learner picked or a new unit for this research.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { serverConvexClient } from "@/lib/server/convex"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads a bounded required string from an apply request. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
}

/** Reads an optional bounded ID; absent, null, or empty means not chosen. */
function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return requiredId(value, label)
}

/** Reads the selected source indexes and rejects client supplied source data. */
function sourceIndexes(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    value.some((index) => !Number.isSafeInteger(index) || index < 0)
  )
    throw new LearningApiError("Source indexes are invalid", 400)
  const indexes = Array.from(value as number[])
  if (new Set(indexes).size !== indexes.length)
    throw new LearningApiError("Source indexes must be unique", 400)
  return indexes
}

/**
 * Queues selected sources using indexes from the persisted ready proposal.
 *
 * Body: `projectId`, `requestId`, `sourceIndexes`, and an optional `unitId`
 * of an existing unit in the project. Without `unitId` the sources go into a
 * new unit created for this research.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Apply request is invalid", 400)
    const input = body as Record<string, unknown>
    const unitId = optionalId(input.unitId, "Unit ID")
    const result = await serverConvexClient(
      () => new LearningApiError("Research service is unavailable", 503)
    ).mutation(api.research.apply, {
      projectId: requiredId(input.projectId, "Project ID") as Id<"projects">,
      requestId: requiredId(input.requestId, "Request ID"),
      sourceIndexes: sourceIndexes(input.sourceIndexes),
      ...(unitId ? { unitId: unitId as Id<"units"> } : {}),
    })
    return Response.json(result, { status: 202 })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    // A deleted or foreign unit is a choice the learner can fix.
    if (error instanceof Error && /Unit was not found/.test(error.message))
      return Response.json(
        { error: "That unit no longer exists. Choose another unit." },
        { status: 400 }
      )
    return Response.json(
      { error: "Research service is unavailable" },
      { status: 503 }
    )
  }
}
