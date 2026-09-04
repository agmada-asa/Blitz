/** Serves the bounded learning feed contract to browser and native clients. */

import { fetchLearningFeed, LearningApiError } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns due/new cards and filter metadata with safe route errors. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const rawLimit = url.searchParams.get("limit")
    const limit = rawLimit === null ? undefined : Number(rawLimit)
    if (rawLimit !== null && !Number.isSafeInteger(limit)) {
      throw new LearningApiError("Feed limit must be an integer", 400)
    }
    return Response.json(
      await fetchLearningFeed({
        projectId: url.searchParams.get("projectId") ?? undefined,
        topicId: url.searchParams.get("topicId") ?? undefined,
        limit,
        cursor: url.searchParams.get("cursor") ?? undefined,
      })
    )
  } catch (error) {
    if (error instanceof LearningApiError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    return Response.json(
      { error: "Learning service is unavailable" },
      { status: 503 }
    )
  }
}
