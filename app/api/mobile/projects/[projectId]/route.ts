/** Returns bounded project-detail data and accepts native paste/link source actions. */

import { ConvexError } from "convex/values"
import { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { extractDownloadedSource } from "@/lib/server/source-ingestion/extract"
import { fetchPublicSource } from "@/lib/server/source-ingestion/url"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Uses Node.js because public-link extraction pins DNS and parses binary sources. */
export const runtime = "nodejs"

const MAX_TEXT_LENGTH = 2_000_000
const MAX_URL_LENGTH = 2_048

/** Creates the configured Convex HTTP client without exposing its URL to native code. */
function client(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint)
    throw new LearningApiError("Projects are unavailable. Try again.", 503)
  return new ConvexHttpClient(endpoint)
}

/** Rejects malformed route identifiers before they reach Convex. */
function projectIdFor(value: string): Id<"projects"> {
  if (!/^[A-Za-z0-9]{1,128}$/.test(value))
    throw new LearningApiError("Project ID is invalid.", 400)
  return value as Id<"projects">
}

/** Converts expected backend failures into safe native-facing responses. */
function failure(error: unknown): Response {
  if (error instanceof LearningApiError)
    return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof ConvexError && typeof error.data === "string")
    return Response.json({ error: error.data }, { status: 400 })
  return Response.json(
    { error: "The project is unavailable. Try again." },
    { status: 503 }
  )
}

/** Returns the screen-safe project detail hierarchy, capped at the same limits as its Convex queries. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const projectId = projectIdFor((await params).projectId)
    const convex = client()
    const [
      project,
      path,
      sourcesPage,
      ingestion,
      artifacts,
      citations,
      research,
    ] = await Promise.all([
      convex.query(api.projects.getProject, { projectId }),
      convex.query(api.learning.getProjectPath, { projectId }),
      convex.query(api.sources.listSources, {
        projectId,
        paginationOpts: { numItems: 20, cursor: null },
      }),
      convex.query(api.projectAgents.listIngestion, { projectId }),
      convex.query(api.projectAgents.listArtifacts, { projectId }),
      convex.query(api.projectAgents.listCitations, { projectId }),
      convex.query(api.research.listForProject, { projectId, limit: 20 }),
    ])
    if (!project)
      return Response.json({ error: "Project not found" }, { status: 404 })
    const sourceIds = sourcesPage.page.map((source) => source._id)
    const preparation = await convex.query(api.preparation.listJobsForProject, {
      projectId,
      sourceIds,
    })
    return Response.json(
      {
        project: { id: String(project._id), title: project.title },
        path,
        sources: sourcesPage.page.map((source) => ({
          id: String(source._id),
          filename: source.filename,
          status: source.status,
          kind: source.kind,
          error: source.error,
          originalUrl: source.originalUrl,
          relativeKey: source.relativeKey,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          unsupported: source.unsupported,
        })),
        ingestion: ingestion.slice(0, 20).map((job) => ({
          sourceId: String(job.sourceId),
          status: job.status,
          error: job.error,
        })),
        preparation: preparation.slice(0, 20).map((job) => ({
          sourceId: String(job.sourceId),
          status: job.status,
          error: job.error,
          nextChunkOrdinal: job.nextChunkOrdinal,
          totalChunks: job.totalChunks,
          generatedItemCount: job.generatedItemCount,
          leaseExpired: job.leaseExpired,
        })),
        artifacts: artifacts.slice(0, 100).map((artifact) => ({
          id: String(artifact._id),
          relativeKey: artifact.relativeKey,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          status: artifact.status,
          updatedAt: artifact.updatedAt,
        })),
        citations: citations.slice(0, 500).map((citation) => ({
          sourceId: String(citation.sourceId),
          label: citation.label,
          detail:
            "detail" in citation && typeof citation.detail === "string"
              ? citation.detail
              : undefined,
        })),
        research: research.slice(0, 20).map((proposal) => ({
          requestId: proposal.requestId,
          request: proposal.request,
          status: proposal.status,
          error:
            "error" in proposal && typeof proposal.error === "string"
              ? proposal.error
              : undefined,
          proposal: proposal.proposal,
          createdAt: proposal.createdAt,
          updatedAt: proposal.updatedAt,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return failure(error)
  }
}

/** Validates and queues pasted notes or a public link for the selected project. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const projectId = projectIdFor((await params).projectId)
    const body = await readLearningJson(request)
    if (!body || typeof body !== "object")
      throw new LearningApiError("Source request is invalid.", 400)
    const input = body as Record<string, unknown>
    const convex = client()
    if (input.action === "paste") {
      const text = typeof input.text === "string" ? input.text.trim() : ""
      const filename =
        typeof input.filename === "string" && input.filename.trim()
          ? input.filename.trim()
          : "Pasted notes.txt"
      if (!text || text.length > MAX_TEXT_LENGTH || filename.length > 255)
        throw new LearningApiError(
          "Paste notes must contain between 1 and 2,000,000 characters.",
          400
        )
      await convex.mutation(api.sources.createAndEnqueue, {
        projectId,
        filename,
        kind: "paste",
        extractedText: text,
      })
      return Response.json({ queued: true }, { status: 202 })
    }
    if (
      input.action !== "link" ||
      typeof input.url !== "string" ||
      !/^https?:\/\//i.test(input.url.trim()) ||
      input.url.trim().length > MAX_URL_LENGTH
    )
      throw new LearningApiError("Enter a valid public source URL.", 400)
    const fetched = await fetchPublicSource(input.url.trim(), {
      maxBytes: 5_000_000,
      timeoutMs: 15_000,
      maxRedirects: 3,
    })
    const extracted = await extractDownloadedSource({
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      url: fetched.url,
    })
    await convex.mutation(api.sources.createAndEnqueue, {
      projectId,
      filename: extracted.filename,
      kind: extracted.kind,
      extractedText: extracted.extractedText,
      originalUrl: fetched.url,
    })
    return Response.json({ queued: true }, { status: 202 })
  } catch (error) {
    return failure(error)
  }
}
