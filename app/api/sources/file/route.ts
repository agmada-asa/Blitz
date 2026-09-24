/** Serves one project source original through an ownership checked source ID. */

import { basename } from "node:path"
import { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"
import { streamProjectFile } from "@/lib/server/project-files"

/** Uses Node because the original source lives in the local project workspace. */
export const runtime = "nodejs"

/** Safe MIME types that can be previewed inline in a sandboxed context without download prompts. */
const INLINE_SAFE_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
])

/** Streams an original source file after resolving its project-owned key. */
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
    if (!source)
      return Response.json(
        { error: "Original source file is unavailable." },
        { status: 404 }
      )

    // Sources created via direct paste or text input may only have persisted extracted text.
    if (!source.relativeKey) {
      if (!source.extractedText)
        return Response.json(
          { error: "Original source file is unavailable." },
          { status: 404 }
        )
      const textBytes = new TextEncoder().encode(source.extractedText)
      const mimeType =
        source.mimeType ||
        (source.kind === "markdown"
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8")
      const isInline =
        url.searchParams.get("inline") === "1" &&
        (INLINE_SAFE_MIME_TYPES.has(source.mimeType ?? "") ||
          source.kind === "markdown" ||
          source.kind === "text" ||
          source.kind === "paste")
      return new Response(textBytes, {
        headers: {
          "cache-control": "no-store",
          "content-type": mimeType,
          "content-disposition": `${isInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(source.filename))}`,
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
          "content-length": String(textBytes.byteLength),
        },
      })
    }

    const file = await streamProjectFile(projectId, source.relativeKey)
    const isInline =
      url.searchParams.get("inline") === "1" &&
      INLINE_SAFE_MIME_TYPES.has(source.mimeType ?? "")
    return new Response(file.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": source.mimeType || "application/octet-stream",
        "content-disposition": `${isInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(source.filename))}`,
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "content-length": String(file.size),
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
