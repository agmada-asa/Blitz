/** Exposes the bounded written-practice mutations to the native client. */

import { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns a configured Convex client or a safe service error. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL
  if (!endpoint)
    throw new LearningApiError("Learning service is unavailable", 503)
  try {
    return new ConvexHttpClient(endpoint)
  } catch {
    throw new LearningApiError("Learning service is unavailable", 503)
  }
}

/** Reads a bounded project or topic identifier from query or mutation data. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 400)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
}

/** Returns a generic safe error response for the native written activity. */
function errorResponse(error: unknown): Response {
  if (error instanceof LearningApiError)
    return Response.json({ error: error.message }, { status: error.status })
  return Response.json(
    { error: "Written activity is unavailable" },
    { status: 503 }
  )
}

/** Loads the latest written activity in a project and optional topic scope. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const projectId = requiredId(
      url.searchParams.get("projectId"),
      "Project ID"
    ) as Id<"projects">
    const topicValue = url.searchParams.get("topicId")
    const client = convexClient()
    const activity = await client.query(api.writing.getLatest, {
      projectId,
      ...(topicValue
        ? { topicId: requiredId(topicValue, "Topic ID") as Id<"topics"> }
        : {}),
    })
    return Response.json(activity)
  } catch (error) {
    return errorResponse(error)
  }
}

/** Starts an activity or saves one native draft or comparison result. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Written activity request is invalid", 400)
    const input = body as Record<string, unknown>
    const action = input.action
    const projectId = requiredId(
      input.projectId,
      "Project ID"
    ) as Id<"projects">
    const client = convexClient()
    if (action === "start") {
      const requestId = requiredId(input.requestId, "Request ID")
      const topicValue = input.topicId
      const activity = await client.mutation(api.writing.start, {
        projectId,
        requestId,
        ...(typeof topicValue === "string" && topicValue.trim()
          ? { topicId: requiredId(topicValue, "Topic ID") as Id<"topics"> }
          : {}),
      })
      return Response.json(activity)
    }
    if (action === "save") {
      if (typeof input.reveal !== "boolean")
        throw new LearningApiError("Reveal flag is invalid", 400)
      if (
        typeof input.answer !== "string" ||
        input.answer.trim().length > 10_000
      )
        throw new LearningApiError("Answer is invalid", 400)
      const activity = await client.mutation(api.writing.saveAnswer, {
        projectId,
        activityId: requiredId(
          input.activityId,
          "Activity ID"
        ) as Id<"writingActivities">,
        itemId: requiredId(input.itemId, "Item ID") as Id<"learningItems">,
        answer: input.answer,
        reveal: input.reveal,
      })
      return Response.json(activity)
    }
    throw new LearningApiError("Written activity action is invalid", 400)
  } catch (error) {
    return errorResponse(error)
  }
}
