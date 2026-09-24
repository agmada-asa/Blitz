/** Serves timed passages for a completed local audiobook or podcast. */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  completedProjectTranscript,
  localConvexClient,
} from "@/lib/server/project-audio"

/** Transcript files and project validation need the Node runtime. */
export const runtime = "nodejs"

/** Returns timed transcript data only for an existing completed project recording. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; audioId: string }> }
): Promise<Response> {
  try {
    const { projectId, audioId } = await context.params
    const project = await localConvexClient().query(api.projects.getProject, {
      projectId: projectId as Id<"projects">,
    })
    if (!project)
      return Response.json({ error: "Project not found" }, { status: 404 })
    const recording = await completedProjectTranscript(projectId, audioId)
    if (!recording)
      return Response.json(
        { error: "The transcript is not ready for this recording" },
        { status: 404 }
      )
    return Response.json(recording, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Transcript is unavailable",
      },
      { status: 400 }
    )
  }
}
