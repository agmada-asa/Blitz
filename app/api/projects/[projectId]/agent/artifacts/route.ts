/** Lists project agent artifacts and synchronizes filesystem metadata in Convex. */
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import {
  prepareProjectAgentWorkspace,
  resolveWritableArtifactPath,
  scanProjectArtifacts,
} from "@/lib/server/project-agent"
import { readProjectFileBytes } from "@/lib/server/project-files"
import { extname } from "node:path"

export const runtime = "nodejs"

/** Lists bounded artifact metadata for one project. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const { projectId } = await context.params
    const endpoint =
      process.env.BLITZ_CONVEX_URL ??
      process.env.NEXT_PUBLIC_CONVEX_URL ??
      process.env.CONVEX_URL
    if (!endpoint) throw new Error("Projects are unavailable")
    const convex = new ConvexHttpClient(endpoint)
    const project = await convex.query(api.projects.getProject, {
      projectId: projectId as never,
    })
    if (!project)
      return Response.json({ error: "Project not found." }, { status: 404 })
    const workspace = await prepareProjectAgentWorkspace(
      projectId,
      project.title
    )
    const relativeKey = new URL(request.url).searchParams.get("key")
    if (relativeKey) {
      const path = resolveWritableArtifactPath(
        workspace.projectDirectory,
        relativeKey
      )
      const body = await readProjectFileBytes(
        projectId,
        relativeKey,
        25_000_000
      )
      const mime =
        extname(path).toLowerCase() === ".md"
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8"
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": mime,
          "content-length": String(body.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").pop() || "artifact")}`,
        },
      })
    }
    const artifacts = await scanProjectArtifacts(workspace.projectDirectory)
    for (const artifact of artifacts)
      await convex.mutation(api.projectAgents.upsertArtifact, {
        projectId: projectId as never,
        ...artifact,
        status: "active",
      })
    return Response.json({ artifacts })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Artifacts are unavailable.",
      },
      { status: 400 }
    )
  }
}
