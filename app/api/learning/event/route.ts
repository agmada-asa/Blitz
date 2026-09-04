/** Accepts skip and exposure events without changing review state. */

import {
  LearningApiError,
  parseEventRequest,
  readLearningJson,
  recordLearningEvent,
} from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Records one passive event through Convex with bounded safe errors. */
export async function POST(request: Request) {
  try {
    const input = parseEventRequest(await readLearningJson(request))
    return Response.json(await recordLearningEvent(input))
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
