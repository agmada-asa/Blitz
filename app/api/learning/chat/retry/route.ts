/** Requeues one failed card-chat message after an explicit client retry action. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads one bounded text identifier from the retry body. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
}

/** Requeues an existing failed message without creating a duplicate history row. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Retry request is invalid", 400)
    const input = body as Record<string, unknown>
    const endpoint =
      process.env.BLITZ_CONVEX_URL ??
      process.env.NEXT_PUBLIC_CONVEX_URL ??
      process.env.CONVEX_URL
    if (!endpoint)
      throw new LearningApiError("Chat service is unavailable", 503)
    const client = new ConvexHttpClient(endpoint)
    const result = await client.mutation(api.conversations.retry, {
      projectId: requiredId(input.projectId, "Project ID") as Id<"projects">,
      itemId: requiredId(input.itemId, "Item ID") as Id<"learningItems">,
      messageId: requiredId(
        input.messageId,
        "Message ID"
      ) as Id<"conversationMessages">,
    })
    return Response.json(result, { status: 202 })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Chat service is unavailable" },
      { status: 503 }
    )
  }
}
