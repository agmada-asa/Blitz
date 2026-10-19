/** Requeues one failed research proposal after an explicit retry action. */

import { serverConvexClient } from "@/lib/server/convex"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads a bounded identifier from a retry request. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
}

/** Requeues the existing proposal without creating another request. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Retry request is invalid", 400)
    const input = body as Record<string, unknown>
    const result = await serverConvexClient(
      () => new LearningApiError("Research service is unavailable", 503)
    ).mutation(api.research.retry, {
      projectId: requiredId(input.projectId, "Project ID") as Id<"projects">,
      requestId: requiredId(input.requestId, "Request ID"),
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
