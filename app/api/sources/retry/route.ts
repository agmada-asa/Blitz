/**
 * Replays a retained original source through the upload route's extraction.
 *
 * Extraction is the only preparation a source needs before Teach can use it,
 * so a retry re-reads the stored original. The ingestion worker also calls
 * this route to recover uploads interrupted by a restart.
 */

import { api } from "@/convex/_generated/api"
import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { serverConvexClient } from "@/lib/server/convex"
import { resolveProjectFile } from "@/lib/server/project-files"

/** Runs on Node because retries read project-local files and call Convex. */
export const runtime = "nodejs"

/** Re-extracts one source unless it is already extracted or being extracted. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      projectId?: unknown
      sourceId?: unknown
    }
    if (typeof body.projectId !== "string" || typeof body.sourceId !== "string")
      return Response.json(
        { error: "Project and source are required" },
        { status: 400 }
      )
    const convex = serverConvexClient()
    const source = await convex.query(api.sources.getOriginalSource, {
      projectId: body.projectId as never,
      sourceId: body.sourceId as never,
    })
    if (!source)
      return Response.json({ error: "Source not found" }, { status: 404 })
    if (source.ingestionStatus === "completed" && source.status !== "failed")
      return Response.json(
        { sourceId: body.sourceId, status: "completed" },
        { headers: { "Cache-Control": "no-store" } }
      )
    if (
      source.ingestionStatus === "running" &&
      (source.ingestionLeaseExpiresAt ?? 0) > Date.now()
    )
      return Response.json(
        { sourceId: body.sourceId, status: "running", pending: true },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      )
    if (!source.relativeKey)
      return Response.json(
        { error: "This source has no stored original to read again." },
        { status: 422 }
      )
    const fileStream = Readable.toWeb(
      createReadStream(
        await resolveProjectFile(body.projectId, source.relativeKey)
      )
    )
    const replayInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "x-blitz-project-id": body.projectId,
        "x-blitz-filename": encodeURIComponent(source.filename),
        ...(source.mimeType ? { "content-type": source.mimeType } : {}),
      },
      body: fileStream as ReadableStream<Uint8Array>,
      duplex: "half",
    }
    const replay = new Request(
      new URL("/api/sources/upload", request.url),
      replayInit
    )
    return POST_REPLAY(replay)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Source retry failed" },
      { status: 400 }
    )
  }
}

/** Dispatches the replay request to the canonical upload implementation without duplicating parsing. */
async function POST_REPLAY(request: Request): Promise<Response> {
  const { POST: upload } = await import("@/app/api/sources/upload/route")
  return upload(request)
}
