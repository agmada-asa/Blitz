/**
 * Answering from memory in Review: reveals a question's answer without
 * recording anything, then records the learner's own verdict on it.
 */

import {
  LearningApiError,
  parseRecallRequest,
  readLearningJson,
  recallLearningItem,
} from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reveals an answer or records a self-graded recall, keeping backend errors safe. */
export async function POST(request: Request) {
  try {
    const input = parseRecallRequest(await readLearningJson(request))
    return Response.json(await recallLearningItem(input))
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
