/** Lists and starts local Kokoro audiobook and project podcast jobs. */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  createProjectAudio,
  listProjectAudio,
  localConvexClient,
  type CreateProjectAudioInput,
} from "@/lib/server/project-audio"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Local generation and project files require the Node runtime. */
export const runtime = "nodejs"

/** Resolves the project before listing or changing its local audio files. */
async function projectForRequest(projectId: string) {
  const client = localConvexClient()
  const project = await client.query(api.projects.getProject, {
    projectId: projectId as Id<"projects">,
  })
  if (!project) throw new Error("Project not found")
  return { client, project }
}

/** Returns the latest persisted audio job states for this project. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const { projectId } = await context.params
    await projectForRequest(projectId)
    return Response.json(
      { items: await listProjectAudio(projectId) },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Audio is unavailable",
      },
      { status: 400 }
    )
  }
}

/** Starts one validated background recording without holding the browser connection open. */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request))
      return Response.json(
        { error: "Audio request is not allowed" },
        { status: 403 }
      )
    const { projectId } = await context.params
    const { client, project } = await projectForRequest(projectId)
    const body = (await request.json()) as Record<string, unknown>
    if (!body || typeof body !== "object")
      throw new Error("Choose an audio format")
    if (body.kind !== "audiobook" && body.kind !== "podcast")
      throw new Error("Choose an audiobook or podcast")
    const input: CreateProjectAudioInput = { kind: body.kind }
    if (body.kind === "audiobook") {
      if (typeof body.sourceId !== "string" || !body.sourceId)
        throw new Error("Choose a source for the audiobook")
      input.sourceId = body.sourceId
    } else {
      if (![15, 30, 60, 90].includes(body.durationMinutes as number))
        throw new Error("Choose a 15, 30, 60, or 90 minute episode")
      input.durationMinutes = body.durationMinutes as 15 | 30 | 60 | 90
      if (body.unitId !== undefined) {
        if (typeof body.unitId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(body.unitId))
          return Response.json({ error: "Choose a valid unit" }, { status: 400 })
        input.unitId = body.unitId
      }
      if (body.focus !== undefined) {
        if (typeof body.focus !== "string" || body.focus.length > 500)
          throw new Error("Keep the podcast focus under 500 characters")
        input.focus = body.focus.trim()
      }
    }
    const item = await createProjectAudio(
      projectId,
      project.title,
      client,
      input
    )
    return Response.json({ item }, { status: 202 })
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Audio could not start",
      },
      { status: 400 }
    )
  }
}
