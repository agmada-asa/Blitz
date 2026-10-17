/**
 * Deletes one source: its records through Convex, then its stored original
 * from the project folder. Convex cannot reach the local disk, so this route
 * owns the second step.
 */

import { api } from "@/convex/_generated/api"
import { serverConvexClient } from "@/lib/server/convex"
import { removeProjectFile } from "@/lib/server/project-files"

/** Runs on Node because the original lives in the local project workspace. */
export const runtime = "nodejs"

/**
 * Deletes the source named in the JSON body (`projectId`, `sourceId`).
 * The file is removed only after the records are gone, so a failed delete
 * never leaves a source pointing at a missing original. A file that cannot be
 * removed is reported but does not undo the delete.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { projectId?: unknown; sourceId?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: "Project and source are required." }, { status: 400 })
  }
  if (typeof body.projectId !== "string" || typeof body.sourceId !== "string")
    return Response.json({ error: "Project and source are required." }, { status: 400 })

  let relativeKey: string | null
  try {
    const result = await serverConvexClient().mutation(api.sources.remove, {
      projectId: body.projectId as never,
      sourceId: body.sourceId as never,
    })
    relativeKey = result.relativeKey
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    // Convex prefixes thrown messages with request details; keep the learner-facing part.
    const known = ["Source not found", "Delete this file by deleting its exam paper in Practice"].find(
      (text) => message.includes(text)
    )
    return Response.json(
      { error: known ? `${known}.` : "The file could not be deleted. Try again." },
      { status: known === "Source not found" ? 404 : known ? 409 : 500 }
    )
  }

  if (relativeKey) {
    try {
      await removeProjectFile(body.projectId, relativeKey)
    } catch {
      return Response.json(
        { deleted: true, fileRemoved: false },
        { headers: { "Cache-Control": "no-store" } }
      )
    }
  }
  return Response.json(
    { deleted: true, fileRemoved: Boolean(relativeKey) },
    { headers: { "Cache-Control": "no-store" } }
  )
}
