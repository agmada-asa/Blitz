/** Polls per-source progress for an approved research proposal import. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError } from "@/lib/server/learning-api"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Reads one bounded query identifier. */
function requiredId(value: string | null, label: string): string {
  if (!value?.trim() || value.trim().length > 200)
    throw new LearningApiError(`${label} is invalid`, 400)
  return value.trim()
}

/** Returns progress for selected sources without exposing their downloaded text. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const endpoint =
      process.env.BLITZ_CONVEX_URL ??
      process.env.NEXT_PUBLIC_CONVEX_URL ??
      process.env.CONVEX_URL
    if (!endpoint)
      throw new LearningApiError("Research service is unavailable", 503)
    const result = await new ConvexHttpClient(endpoint).query(
      api.research.listImports,
      {
        projectId: requiredId(
          url.searchParams.get("projectId"),
          "Project ID"
        ) as Id<"projects">,
        requestId: requiredId(url.searchParams.get("requestId"), "Request ID"),
      }
    )
    return Response.json({ imports: result })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Research service is unavailable" },
      { status: 503 }
    )
  }
}
