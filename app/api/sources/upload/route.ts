/** Streams original source bytes into the user's project folder. */

import { storeOriginalSource } from "@/lib/server/source-files"
import { randomUUID } from "node:crypto"
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import { resolveProjectFile } from "@/lib/server/project-files"
import { extractStoredSource } from "@/lib/server/source-ingestion/extract"
import { normalizeSourceDocument } from "@/lib/server/source-ingestion/normalize"
import { segmentSourceDocument } from "@/lib/server/source-ingestion/segment"

/** Uses Node.js streams and the local filesystem for durable upload storage. */
export const runtime = "nodejs"

/** Connects this local route to the configured personal Convex deployment. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new Error("Convex is unavailable")
  return new ConvexHttpClient(endpoint)
}

/** Returns the server source kind and whether deterministic extraction supports a filename. */
function sourceFormat(filename: string): {
  kind: "pdf" | "markdown" | "text"
  supported: boolean
} {
  if (/\.pdf$/i.test(filename)) return { kind: "pdf", supported: true }
  if (/\.(md|markdown)$/i.test(filename))
    return { kind: "markdown", supported: true }
  if (
    /\.(txt|pptx|html?|csv|json|xml|ya?ml|toml|py|tsx?|jsx?|css|scss|sql|sh|bash|zsh|rs|go|c|cpp|h|java|kt|rb|php)$/i.test(
      filename
    )
  )
    return { kind: "text", supported: true }
  return { kind: "text", supported: false }
}

/** Stores one original upload after validating its required transport metadata. */
export async function POST(request: Request): Promise<Response> {
  const projectId = request.headers.get("x-blitz-project-id")?.trim() ?? ""
  const filename = request.headers.get("x-blitz-filename")?.trim() ?? ""
  if (!projectId || !filename)
    return Response.json(
      { error: "Project and filename are required" },
      { status: 400 }
    )
  if (!request.body)
    return Response.json({ error: "Source upload is empty" }, { status: 400 })
  try {
    const convex = convexClient()
    const project = await convex.query(api.projects.getProject, {
      projectId: projectId as never,
    })
    if (!project)
      return Response.json({ error: "Project not found" }, { status: 404 })
    const stored = await storeOriginalSource({
      projectId,
      filename,
      mimeType: request.headers.get("content-type"),
      body: request.body,
    })
    const format = sourceFormat(stored.filename)
    const record = await convex.mutation(api.sources.createOriginalSource, {
      projectId: projectId as never,
      filename: stored.filename,
      kind: format.kind,
      relativeKey: stored.key,
      mimeType: stored.mimeType ?? undefined,
      sizeBytes: stored.size,
      contentHash: stored.sha256,
      unsupported: !format.supported,
    })
    if (record.duplicate || !record.ingestionJobId) {
      const ingestionStillRunning =
        record.ingestionStatus === "running" &&
        (record.ingestionLeaseExpiresAt ?? 0) > Date.now()
      return Response.json(
        {
          ...stored,
          sourceId: record.sourceId,
          duplicate: true,
          pending: ingestionStillRunning,
          unsupported: "unsupported" in record ? record.unsupported : false,
        },
        {
          status: ingestionStillRunning ? 202 : 200,
          headers: { "Cache-Control": "no-store" },
        }
      )
    }
    const leaseToken = randomUUID()
    if (
      !(await convex.mutation(api.sources.claimOriginalIngestion, {
        ingestionJobId: record.ingestionJobId,
        leaseToken,
      }))
    )
      return Response.json(
        { ...stored, sourceId: record.sourceId, duplicate: true },
        { status: 202 }
      )
    if (!format.supported) {
      await convex.mutation(api.sources.completeOriginalIngestion, {
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        extractedText: "",
        status: "completed",
        unsupported: true,
      })
      return Response.json(
        { ...stored, sourceId: record.sourceId, unsupported: true },
        { headers: { "Cache-Control": "no-store" } }
      )
    }
    try {
      const extracted = await extractStoredSource({
        path: await resolveProjectFile(projectId, stored.key),
        sizeBytes: stored.size,
        filename: stored.filename,
        contentType: stored.mimeType,
      })
      const normalized = normalizeSourceDocument({
        sourceId: String(record.sourceId),
        filename: stored.filename,
        kind: extracted.kind,
        text: extracted.extractedText,
      })
      if (Buffer.byteLength(normalized.text, "utf8") > 500_000)
        throw new Error(
          "Extracted text exceeds the automatic preparation boundary."
        )
      const chunks = segmentSourceDocument(normalized)
      await convex.mutation(api.sourceRetrieval.replaceChunks, {
        projectId: projectId as never,
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        chunks: chunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          text: chunk.text,
          textHash: chunk.id.replace(/^chunk_/, ""),
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          references: chunk.references.map((reference) => ({
            ...(reference.marker ? { kind: reference.marker.kind } : {}),
            value: reference.marker?.value ?? "",
            label: reference.marker?.label ?? reference.filename ?? "Source",
            startOffset: reference.startOffset,
            endOffset: reference.endOffset,
          })),
        })),
      })
      await convex.mutation(api.sources.completeOriginalIngestion, {
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        extractedText: normalized.text,
        status: "completed",
      })
      return Response.json(
        {
          ...stored,
          sourceId: record.sourceId,
          ingestionJobId: record.ingestionJobId,
          extracted: true,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Source extraction failed"
      await convex.mutation(api.sources.completeOriginalIngestion, {
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        extractedText: "",
        status: "completed",
        unsupported: true,
      })
      return Response.json(
        {
          ...stored,
          sourceId: record.sourceId,
          ingestionJobId: record.ingestionJobId,
          unsupported: true,
          extractionError: message,
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Source upload failed"
    const status = /empty/i.test(message) ? 400 : 500
    return Response.json({ error: message }, { status })
  }
}
