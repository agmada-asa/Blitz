/** Streams original source bytes into the user's project folder. */

import { storeOriginalSource } from "@/lib/server/source-files"
import { randomUUID } from "node:crypto"
import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"
import { api } from "@/convex/_generated/api"
import { resolveProjectFile } from "@/lib/server/project-files"
import { SourceIngestionError } from "@/lib/server/source-ingestion/errors"
import { persistedChunkRows } from "@/lib/server/source-ingestion/chunk-rows"
import { prepareStoredSource } from "@/lib/server/source-ingestion/prepare"

/** Uses Node.js streams and the local filesystem for durable upload storage. */
export const runtime = "nodejs"

/** Connects this local route to the configured personal Convex deployment. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(() => new Error("Convex is unavailable"))
}

/**
 * Decodes a percent-encoded header value. Browsers reject non-ASCII header
 * text, so the uploader encodes filenames; plain ASCII names pass through.
 */
function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Returns the server source kind and whether deterministic extraction supports a filename. */
function sourceFormat(filename: string): {
  kind: "pdf" | "markdown" | "text"
  supported: boolean
} {
  if (/\.pdf$/i.test(filename)) return { kind: "pdf", supported: true }
  // Word documents are extracted as Markdown, with headings kept for citations.
  if (/\.(md|markdown|docx)$/i.test(filename))
    return { kind: "markdown", supported: true }
  if (
    /\.(txt|vtt|srt|pptx|html?|csv|json|xml|ya?ml|toml|py|tsx?|jsx?|css|scss|sql|sh|bash|zsh|rs|go|c|cpp|h|java|kt|rb|php)$/i.test(
      filename
    )
  )
    return { kind: "text", supported: true }
  return { kind: "text", supported: false }
}

/**
 * Largest extracted text stored on the source record. Convex documents are
 * capped near 1 MB; the complete text stays searchable through source chunks.
 */
const MAX_STORED_TEXT_BYTES = 450_000

/** Sections written per Convex call, keeping each request well under its size limit. */
const CHUNK_BATCH = 200

/**
 * Extracted characters above which a source is a module-wide reference, about
 * 250 dense pages. Teach searches references instead of reading them whole.
 */
const REFERENCE_SOURCE_CHARACTERS = 600_000

/** Truncates text to a UTF-8 byte budget without splitting a character. */
function boundedStoredText(text: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= MAX_STORED_TEXT_BYTES) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(text.slice(0, middle)).byteLength <= MAX_STORED_TEXT_BYTES)
      low = middle
    else high = middle - 1
  }
  return text.slice(0, low)
}

/**
 * Stores one original upload after validating its required transport metadata.
 *
 * Headers: `x-blitz-project-id` and `x-blitz-filename` are required;
 * `x-blitz-unit-id` files the source under a unit, and `x-blitz-source-url`
 * records the page a fetched link came from. Pasted notes and fetched
 * links arrive here as text bodies so every source gets the same extraction,
 * chunking, and citations.
 */
export async function POST(request: Request): Promise<Response> {
  const projectId = request.headers.get("x-blitz-project-id")?.trim() ?? ""
  const unitId = request.headers.get("x-blitz-unit-id")?.trim() || undefined
  const originalUrl =
    decodeHeaderValue(request.headers.get("x-blitz-source-url")?.trim() ?? "") ||
    undefined
  const filename = decodeHeaderValue(
    request.headers.get("x-blitz-filename")?.trim() ?? ""
  )
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
      ...(unitId ? { unitId: unitId as never } : {}),
      ...(originalUrl ? { originalUrl } : {}),
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
          // Which unit the existing copy belongs to, so the uploader can tell
          // whether this unit gained anything.
          ...("unitId" in record && record.unitId ? { unitId: record.unitId } : {}),
          ...("reference" in record && record.reference ? { reference: true } : {}),
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
      const { document: normalized, chunks } = await prepareStoredSource(
        {
          path: await resolveProjectFile(projectId, stored.key),
          sizeBytes: stored.size,
          filename: stored.filename,
          contentType: stored.mimeType,
        },
        String(record.sourceId)
      )
      const rows = persistedChunkRows(chunks)
      // Large sources are written in batches: the first replaces any earlier
      // sections, the rest append, all under the same ingestion lease.
      for (let start = 0; start === 0 || start < rows.length; start += CHUNK_BATCH) {
        await convex.mutation(api.sourceRetrieval.replaceChunks, {
          projectId: projectId as never,
          sourceId: record.sourceId,
          ingestionJobId: record.ingestionJobId,
          leaseToken,
          append: start > 0,
          chunks: rows.slice(start, start + CHUNK_BATCH),
        })
      }
      // A whole book backs up every unit instead of being taught as one. Mark
      // it before completing, while the lease is still held, so a failure here
      // fails the upload cleanly instead of leaving a book taught as a unit.
      const reference = normalized.text.length > REFERENCE_SOURCE_CHARACTERS
      if (reference)
        await convex.mutation(api.sources.markReference, {
          sourceId: record.sourceId,
        })
      await convex.mutation(api.sources.completeOriginalIngestion, {
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        extractedText: boundedStoredText(normalized.text),
        status: "completed",
      })
      return Response.json(
        {
          ...stored,
          sourceId: record.sourceId,
          ingestionJobId: record.ingestionJobId,
          extracted: true,
          ...(reference ? { reference: true } : {}),
        },
        { headers: { "Cache-Control": "no-store" } }
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Source extraction failed"
      // A document Blitz cannot read (no text layer, unknown format) stays
      // saved but unreadable; anything else is a failure the learner can retry.
      const unreadable = error instanceof SourceIngestionError
      await convex.mutation(api.sources.completeOriginalIngestion, {
        sourceId: record.sourceId,
        ingestionJobId: record.ingestionJobId,
        leaseToken,
        extractedText: "",
        status: unreadable ? "completed" : "failed",
        ...(unreadable ? { unsupported: true } : {}),
        error: message.slice(0, 300),
      })
      if (!unreadable)
        return Response.json(
          { error: "This file could not be prepared. Try again." },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        )
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
