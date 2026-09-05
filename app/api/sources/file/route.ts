/** Serves one project source original through an ownership checked source ID. */

import { basename } from "node:path"
import { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"
import { readProjectFileBytes } from "@/lib/server/project-files"

/** Uses Node because the original source lives in the local project workspace. */
export const runtime = "nodejs"

/** Returns a bounded original source file after resolving its project-owned key. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const projectId = url.searchParams.get("projectId")
  const sourceId = url.searchParams.get("sourceId")
  if (!projectId || !sourceId)
    return Response.json(
      { error: "Project and source are required." },
      { status: 400 }
    )
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint)
    return Response.json({ error: "Sources are unavailable." }, { status: 503 })
  try {
    const convex = new ConvexHttpClient(endpoint)
    const source = await convex.query(api.sources.getOriginalSource, {
      projectId: projectId as never,
      sourceId: sourceId as never,
    })
    if (!source?.relativeKey)
      return Response.json(
        { error: "Original source file is unavailable." },
        { status: 404 }
      )
    const bytes = await readProjectFileBytes(
      projectId,
      source.relativeKey,
      50_000_000
    )
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-type": source.mimeType || "application/octet-stream",
        "content-disposition": `${url.searchParams.get("inline") === "1" && ["application/pdf", "text/plain", "text/markdown"].includes(source.mimeType ?? "") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(source.filename))}`,
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "content-length": String(bytes.byteLength),
      },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Source file is unavailable.",
      },
      { status: 404 }
    )
  }
}
