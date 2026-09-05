/** Replays a retained original source through the durable server ingestion pipeline. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { resolveProjectFile } from "@/lib/server/project-files"

/** Runs on Node because retries read project-local files and call Convex. */
export const runtime = "nodejs"

/** Requeues one failed source by replaying its original bytes through upload. */
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
    const endpoint =
      process.env.BLITZ_CONVEX_URL ??
      process.env.NEXT_PUBLIC_CONVEX_URL ??
      process.env.CONVEX_URL
    if (!endpoint) throw new Error("Convex is unavailable")
    const convex = new ConvexHttpClient(endpoint)
    const source = await convex.query(api.sources.getOriginalSource, {
      projectId: body.projectId as never,
      sourceId: body.sourceId as never,
    })
    if (!source)
      return Response.json({ error: "Source not found" }, { status: 404 })
    const jobs = await convex.query(api.preparation.listJobsForProject, {
      projectId: body.projectId as never,
      sourceIds: [body.sourceId as never],
    })
    const preparation = jobs[0]
    if (preparation?.status === "failed")
      return Response.json(
        await convex.mutation(api.preparation.retry, {
          jobId: preparation.jobId,
        })
      )
    if (!source.relativeKey)
      return Response.json(
        await convex.mutation(api.preparation.enqueue, {
          projectId: body.projectId as never,
          sourceId: body.sourceId as never,
        })
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
        "x-blitz-filename": source.filename,
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
