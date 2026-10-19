/** Resolves the selected project's native workspace and attached chat instructions. */
import { serverConvexClient } from "@/lib/server/convex"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  prepareProjectAgentWorkspace,
  projectAgentInstructions,
} from "@/lib/server/project-agent"

/** Workspace preparation requires the local Node filesystem. */
export const runtime = "nodejs"

/** Returns workspace metadata for native file actions; agent messages are submitted through Chat. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const { projectId } = await context.params
    const project = await serverConvexClient(
      () => new Error("Projects are unavailable.")
    ).query(api.projects.getProject, { projectId: projectId as Id<"projects"> })
    if (!project)
      return Response.json({ error: "Project not found." }, { status: 404 })
    const workspace = await prepareProjectAgentWorkspace(projectId)
    return Response.json(
      {
        workspaceDirectory: workspace.projectDirectory,
        instructions: projectAgentInstructions(workspace.projectDirectory),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Workspace is unavailable.",
      },
      { status: 400 }
    )
  }
}
