/** Provides snapshot and streaming card-chat contracts for browser and native clients. */

import { chatStream } from "@/lib/server/chat-stream"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads a bounded non-empty text field from request input. */
function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new LearningApiError(`${label} is required`, 400)
  const text = value.trim()
  if (!text) throw new LearningApiError(`${label} is required`, 400)
  if (text.length > maximum)
    throw new LearningApiError(`${label} is too long`, 400)
  return text
}

/** Creates a server-only Convex client from the local deployment URL. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new LearningApiError("Chat service is unavailable", 503)
  try {
    return new ConvexHttpClient(endpoint)
  } catch {
    throw new LearningApiError("Chat service is unavailable", 503)
  }
}

/** Parses the intentionally small POST body used by web and native clients. */
async function parsePost(request: Request): Promise<{
  projectId: string
  itemId: string
  clientMessageId: string
  question: string
}> {
  const body = await readLearningJson(request)
  if (!body || typeof body !== "object")
    throw new LearningApiError("Chat request is invalid", 400)
  const input = body as Record<string, unknown>
  return {
    projectId: requiredText(input.projectId, "Project ID", 200),
    itemId: requiredText(input.itemId, "Item ID", 200),
    clientMessageId: requiredText(
      input.clientMessageId,
      "Client message ID",
      200
    ),
    question: requiredText(input.question, "Question", 2_000),
  }
}

/** Queues one learner-authored question idempotently for the selected card. */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = await parsePost(request)
    const result = await convexClient().mutation(api.conversations.enqueue, {
      projectId: input.projectId as Id<"projects">,
      itemId: input.itemId as Id<"learningItems">,
      clientMessageId: input.clientMessageId,
      question: input.question,
    })
    return Response.json(
      {
        ...result,
        messageId: result.message.id,
        status: result.message.status,
      },
      { status: 202 }
    )
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Chat service is unavailable" },
      { status: 503 }
    )
  }
}

/** Returns conversation messages and status without returning source material. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const projectId = requiredText(
      url.searchParams.get("projectId"),
      "Project ID",
      200
    )
    const itemId = requiredText(url.searchParams.get("itemId"), "Item ID", 200)
    const client = convexClient()
    const args = {
      projectId: projectId as Id<"projects">,
      itemId: itemId as Id<"learningItems">,
    }
    const result = await client.query(api.conversations.get, args)
    if (url.searchParams.get("stream") === "1")
      return chatStream(client.url, args, request.signal)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Chat service is unavailable" },
      { status: 503 }
    )
  }
}
