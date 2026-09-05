/** Replays a retained original source through the durable server ingestion pipeline. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import { promises as fs } from "node:fs"
import { resolveProjectFile } from "@/lib/server/project-files"

/** Runs on Node because retries read project-local files and call Convex. */
export const runtime = "nodejs"

/** Requeues one failed source by replaying its original bytes through upload. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { projectId?: unknown; sourceId?: unknown }
    if (typeof body.projectId !== "string" || typeof body.sourceId !== "string")
      return Response.json({ error: "Project and source are required" }, { status: 400 })
    const endpoint = process.env.BLITZ_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL
    if (!endpoint) throw new Error("Convex is unavailable")
    const convex = new ConvexHttpClient(endpoint)
    const source = await convex.query(api.sources.getOriginalSource, { projectId: body.projectId as never, sourceId: body.sourceId as never })
    if (!source?.relativeKey) return Response.json({ error: "Original source file is unavailable" }, { status: 404 })
    const bytes = await fs.readFile(await resolveProjectFile(body.projectId, source.relativeKey))
    const replay = new Request(new URL("/api/sources/upload", request.url), { method: "POST", headers: { "x-blitz-project-id": body.projectId, "x-blitz-filename": source.filename, ...(source.mimeType ? { "content-type": source.mimeType } : {}) }, body: bytes })
    return POST_REPLAY(replay)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Source retry failed" }, { status: 400 })
  }
}

/** Dispatches the replay request to the canonical upload implementation without duplicating parsing. */
async function POST_REPLAY(request: Request): Promise<Response> {
  const { POST: upload } = await import("@/app/api/sources/upload/route")
  return upload(request)
}
