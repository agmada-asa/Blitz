/** Enqueues explicitly approved source indexes from a stored research proposal. */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads a bounded required string from an apply request. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
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

/** Creates a client for the configured local Convex deployment. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(
    () => new LearningApiError("Research service is unavailable", 503)
  )
}

/** Queues selected sources using indexes from the persisted ready proposal. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Apply request is invalid", 400)
    const input = body as Record<string, unknown>
    const result = await convexClient().mutation(api.research.apply, {
      projectId: requiredId(input.projectId, "Project ID") as Id<"projects">,
      requestId: requiredId(input.requestId, "Request ID"),
      sourceIndexes: sourceIndexes(input.sourceIndexes),
    })
    return Response.json(result, { status: 202 })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Research service is unavailable" },
      { status: 503 }
    )
  }
}
