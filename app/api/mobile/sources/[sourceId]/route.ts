/** Returns bounded source metadata and extracted text for the native preview. */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError } from "@/lib/server/learning-api"

/** Uses Node.js because the route reads the persisted source record. */
export const runtime = "nodejs"

/** Creates the configured Convex client or reports a safe service error. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(
    () => new LearningApiError("Sources are unavailable.", 503)
  )
}

/** Validates a route ID before passing it to Convex. */
function sourceIdFor(value: string, label: string): string {
  if (!/^[A-Za-z0-9]{1,128}$/.test(value))
    throw new LearningApiError(`${label} is invalid.`, 400)
  return value
}

/** Converts source lookup failures into native-safe responses. */
function failure(error: unknown): Response {
  if (error instanceof LearningApiError)
    return Response.json({ error: error.message }, { status: error.status })
  return Response.json({ error: "The source is unavailable." }, { status: 503 })
}

/** Returns one project-owned source with only preview-safe fields. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> }
): Promise<Response> {
  try {
    const projectId = sourceIdFor(
      new URL(request.url).searchParams.get("projectId") ?? "",
      "Project ID"
    ) as Id<"projects">
    const sourceId = sourceIdFor(
      (await params).sourceId,
      "Source ID"
    ) as Id<"sources">
    const convex = convexClient()
    const [source, citations] = await Promise.all([
      convex.query(api.sources.getSource, { projectId, sourceId }),
      convex.query(api.projectAgents.listCitations, { projectId }),
    ])
    if (!source)
      return Response.json({ error: "Source not found." }, { status: 404 })
    return Response.json(
      {
        id: String(source._id),
        projectId: String(source.projectId),
        filename: source.filename,
        status: source.status,
        kind: source.kind,
        error: source.error,
        originalUrl: source.originalUrl,
        relativeKey: source.relativeKey,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        unsupported: source.unsupported,
        summary: source.summary,
        extractedText: source.extractedText.slice(0, 500_000),
        createdAt: source.createdAt,
        citations: citations
          .filter(
            (citation) => String(citation.sourceId) === String(source._id)
          )
          .slice(0, 500)
          .map((citation) => ({
            label: citation.label,
            detail:
              "detail" in citation && typeof citation.detail === "string"
                ? citation.detail
                : undefined,
          })),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return failure(error)
  }
}
