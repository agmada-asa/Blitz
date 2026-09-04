/** Provides the approval-first research proposal polling contract. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads a bounded non-empty field from an HTTP request. */
function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string")
    throw new LearningApiError(`${label} is required`, 400)
  const text = value.trim()
  if (!text) throw new LearningApiError(`${label} is required`, 400)
  if (text.length > maximum)
    throw new LearningApiError(`${label} is too long`, 400)
  return text
}

/** Creates a Convex client for the configured local deployment. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint)
    throw new LearningApiError("Research service is unavailable", 503)
  try {
    return new ConvexHttpClient(endpoint)
  } catch {
    throw new LearningApiError("Research service is unavailable", 503)
  }
}

/** Reads the three-field proposal request accepted by browser and native clients. */
async function parseRequest(
  request: Request
): Promise<{ projectId: string; requestId: string; request: string }> {
  const body = await readLearningJson(request)
  if (!body || typeof body !== "object")
    throw new LearningApiError("Research request is invalid", 400)
  const input = body as Record<string, unknown>
  return {
    projectId: requiredText(input.projectId, "Project ID", 200),
    requestId: requiredText(input.requestId, "Request ID", 200),
    request: requiredText(input.request, "Research request", 2_000),
  }
}

/** Queues one proposal without downloading, importing, or applying any source. */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = await parseRequest(request)
    const result = await convexClient().mutation(api.research.enqueue, {
      projectId: input.projectId as Id<"projects">,
      requestId: input.requestId,
      request: input.request,
    })
    return Response.json(
      { ...result, proposalId: result.proposalId },
      { status: 202 }
    )
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Research service is unavailable" },
      { status: 503 }
    )
  }
}

/** Returns a proposal status and ready plan without source content. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const projectId = requiredText(
      url.searchParams.get("projectId"),
      "Project ID",
      200
    )
    const requestIdValue = url.searchParams.get("requestId")
    const client = convexClient()
    const rawLimit = url.searchParams.get("limit")
    const limit = rawLimit === null ? 20 : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new LearningApiError("Proposal limit must be between 1 and 20", 400)
    const result = requestIdValue
      ? await client.query(api.research.get, {
          projectId: projectId as Id<"projects">,
          requestId: requiredText(requestIdValue, "Request ID", 200),
        })
      : await client.query(api.research.listForProject, {
          projectId: projectId as Id<"projects">,
          limit,
        })
    return Response.json(result)
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Research service is unavailable" },
      { status: 503 }
    )
  }
}
