/** Accepts one learning answer and returns server-scored feedback. */

import {
  answerLearningItem,
  LearningApiError,
  parseAnswerRequest,
  readLearningJson,
} from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Scores one answer through Convex while keeping request and backend errors safe. */
export async function POST(request: Request) {
  try {
    const input = parseAnswerRequest(await readLearningJson(request))
    return Response.json(await answerLearningItem(input))
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
