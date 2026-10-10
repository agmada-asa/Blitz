/** Explicitly promotes one generated project artifact into the source pipeline. */
import { constants, promises as fs } from "node:fs"
import { basename, extname } from "node:path"
import { serverConvexClient } from "@/lib/server/convex"
import { api } from "@/convex/_generated/api"
import {
  prepareProjectAgentWorkspace,
  resolveWritableArtifactPath,
} from "@/lib/server/project-agent"
import { resolveProjectFile } from "@/lib/server/project-files"

export const runtime = "nodejs"
const MAX_PROMOTED_BYTES = 120_000

/** Reads one bounded artifact and creates a normal queued source record. */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const body = (await request.json()) as { relativeKey?: unknown }
    if (typeof body.relativeKey !== "string")
      return Response.json(
        { error: "Artifact key is required." },
        { status: 400 }
      )
    const { projectId } = await context.params
    const convex = serverConvexClient(
      () => new Error("Projects are unavailable")
    )
    const project = await convex.query(api.projects.getProject, {
      projectId: projectId as never,
    })
    if (!project)
      return Response.json({ error: "Project not found." }, { status: 404 })
    const workspace = await prepareProjectAgentWorkspace(
      projectId,
      project.title
    )
    resolveWritableArtifactPath(workspace.projectDirectory, body.relativeKey)
    const path = await resolveProjectFile(
      projectId,
      body.relativeKey,
      project.title
    )
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_PROMOTED_BYTES)
        return Response.json(
          { error: "Only files up to 120 KB can be added to sources." },
          { status: 400 }
        )
      const extension = extname(path).toLowerCase()
      const kind =
        extension === ".md" || extension === ".markdown"
          ? "markdown"
          : extension === ".txt"
            ? "text"
            : null
      if (!kind)
        return Response.json(
          {
            error: "Only Markdown and text artifacts can be added to sources.",
          },
          { status: 415 }
        )
      const bytes = await handle.readFile()
      if (!bytes.toString("utf8").trim())
        return Response.json(
          { error: "The artifact is empty." },
          { status: 400 }
        )
      const { POST: upload } = await import("@/app/api/sources/upload/route")
      return upload(
        new Request(new URL("/api/sources/upload", request.url), {
          method: "POST",
          headers: {
            "x-blitz-project-id": projectId,
            "x-blitz-filename": `Agent-derived - ${basename(path)}`,
            "content-type":
              kind === "markdown" ? "text/markdown" : "text/plain",
          },
          body: bytes,
        })
      )
    } finally {
      await handle.close()
    }
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Artifact could not be added to sources.",
      },
      { status: 400 }
    )
  }
}
