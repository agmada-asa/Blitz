/** Reviews and approves agent-derived source text for one local project. */
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import { promises as fs } from "node:fs"
import {
  approveDerivedSource,
  cacheDerivedText,
  listDerivedSources,
  markDerivedUploaded,
  readDerivedText,
} from "@/lib/server/derived-sources"
import { resolveProjectFile } from "@/lib/server/project-files"

/** Runs on Node because the handler owns local project files. */
export const runtime = "nodejs"

/** Returns a Convex client when the local project service is configured. */
function convexClient(): ConvexHttpClient {
  const endpoint = process.env.BLITZ_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL
  if (!endpoint) throw new Error("Projects are unavailable")
  return new ConvexHttpClient(endpoint)
}

/** Ensures a request belongs to the local application origin. */
function assertLocalOrigin(request: Request): void {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin)
    throw new Error("Derived source request is not allowed")
}

/** Lists pending and approved derived items without exposing their text. */
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  try {
    assertLocalOrigin(request)
    const { projectId } = await context.params
    const project = await convexClient().query(api.projects.getProject, { projectId: projectId as never })
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 })
    const itemId = new URL(request.url).searchParams.get("id")
    if (itemId) return Response.json({ id: itemId, text: await readDerivedText(projectId, itemId) })
    const items = await listDerivedSources(projectId)
    return Response.json({ items })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Derived sources unavailable" }, { status: 400 })
  }
}

/** Caches new derived text or explicitly approves an existing item. */
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  try {
    assertLocalOrigin(request)
    const { projectId } = await context.params
    const body = (await request.json()) as { action?: unknown; sourceKey?: unknown; text?: unknown; id?: unknown }
    const project = await convexClient().query(api.projects.getProject, { projectId: projectId as never })
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 })
    if (body.action === "approve" && typeof body.id === "string") {
      const current = (await listDerivedSources(projectId)).find((item) => item.id === body.id)
      if (!current) return Response.json({ error: "Derived source not found" }, { status: 404 })
      if (!current.uploadedAt) {
        const approved = current.status === "approved" ? current : await approveDerivedSource(projectId, body.id)
        const text = await readDerivedText(projectId, body.id)
        const filename = `Agent-derived - ${approved.sourceKey.split(/[\\/]/).pop() ?? "source"}.txt`
        const { POST: upload } = await import("@/app/api/sources/upload/route")
        const uploadResponse = await upload(new Request(request.url, {
          method: "POST",
          headers: { "x-blitz-project-id": projectId, "x-blitz-filename": filename, "content-type": "text/plain" },
          body: new TextEncoder().encode(text),
        }))
        if (!uploadResponse.ok) return uploadResponse
        await markDerivedUploaded(projectId, body.id)
      }
      return Response.json({ item: (await listDerivedSources(projectId)).find((item) => item.id === body.id) })
    }
    if (typeof body.sourceKey !== "string" || typeof body.text !== "string")
      return Response.json({ error: "Source key and derived text are required" }, { status: 400 })
    await fs.stat(await resolveProjectFile(projectId, body.sourceKey))
    return Response.json({ item: await cacheDerivedText(projectId, body.sourceKey, body.text) }, { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Derived source request failed" }, { status: 400 })
  }
}
