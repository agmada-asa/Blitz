/** Streams a completed local project recording with browser seeking support. */

import { createReadStream, promises as fs } from "node:fs"
import { Readable } from "node:stream"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  completedProjectAudio,
  localConvexClient,
} from "@/lib/server/project-audio"

/** Local project files require the Node runtime. */
export const runtime = "nodejs"

/** Parses one standard byte range, rejecting requests outside the file. */
function requestedRange(
  value: string | null,
  size: number
): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) throw new Error("Unsupported audio range")
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    end >= size
  )
    throw new Error("Audio range is outside the file")
  return { start, end }
}

/** Serves only a completed file belonging to an existing project. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; audioId: string }> }
): Promise<Response> {
  try {
    const { projectId, audioId } = await context.params
    const project = await localConvexClient().query(api.projects.getProject, {
      projectId: projectId as Id<"projects">,
    })
    if (!project)
      return Response.json({ error: "Project not found" }, { status: 404 })
    const recording = await completedProjectAudio(projectId, audioId)
    if (!recording)
      return Response.json({ error: "Audio is not ready" }, { status: 404 })
    const size = (await fs.stat(recording.path)).size
    const range = requestedRange(request.headers.get("range"), size)
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const filename = `${recording.item.kind}-${audioId}.wav`
    const download = new URL(request.url).searchParams.has("download")
    const stream = createReadStream(recording.path, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        ...(download
          ? { "Content-Disposition": `attachment; filename="${filename}"` }
          : {}),
      },
    })
  } catch (error) {
    const rangeError = error instanceof Error && error.message.includes("range")
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Audio is unavailable",
      },
      { status: rangeError ? 416 : 400 }
    )
  }
}
