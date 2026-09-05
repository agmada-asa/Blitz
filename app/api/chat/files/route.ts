/** Stores ad hoc chat originals and serves them through project-scoped document IDs. */
import { ConvexHttpClient } from "convex/browser"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import { storeOriginalSource } from "@/lib/server/source-files"
import {
  readProjectFileBytes,
  resolveProjectFile,
} from "@/lib/server/project-files"
import { extractStoredSource } from "@/lib/server/source-ingestion/extract"

/** Uses local storage and deterministic extraction on the Node host. */
export const runtime = "nodejs"

/** Connects to the same personal deployment as the chat route. */
function client(): ConvexHttpClient {
  const url =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!url) throw new Error("Chat files are unavailable")
  return new ConvexHttpClient(url)
}

/** Saves an original and its full extracted text, rejecting unsupported or unreadable files. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request))
      return Response.json(
        { error: "Open Blitz to attach a file." },
        { status: 403 }
      )
    const projectId = request.headers.get(
      "x-blitz-project-id"
    ) as Id<"projects"> | null
    const filename = decodeURIComponent(
      request.headers.get("x-blitz-filename") ?? ""
    )
    if (!projectId || !filename || !request.body)
      throw new Error("Project and file are required.")
    if (!/\.(pdf|md|markdown|txt|pptx)$/i.test(filename))
      throw new Error("Choose a PDF, PowerPoint, Markdown, or text file.")
    if (Number(request.headers.get("content-length")) > 50_000_000)
      throw new Error("Chat files must be under 50 MB.")
    const convex = client()
    if (!(await convex.query(api.projects.getProject, { projectId })))
      throw new Error("Project not found.")
    const stored = await storeOriginalSource({
      projectId,
      filename,
      body: request.body,
      mimeType: request.headers.get("content-type"),
      maxBytes: 50_000_000,
    })
    const extracted = await extractStoredSource({
      path: await resolveProjectFile(projectId, stored.key),
      filename: stored.filename,
      sizeBytes: stored.size,
      contentType: stored.mimeType,
    })
    if (!extracted.extractedText.trim())
      throw new Error("There was no readable text in that file.")
    if (new TextEncoder().encode(extracted.extractedText).length > 500_000)
      throw new Error(
        "This file has too much text. Split it into smaller files."
      )
    const mimeType = /\.pdf$/i.test(filename)
      ? "application/pdf"
      : /\.pptx$/i.test(filename)
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "text/plain"
    const documentId = await convex.mutation(api.chatCitations.createDocument, {
      projectId,
      filename: stored.filename,
      relativeKey: stored.key,
      text: extracted.extractedText,
      mimeType,
      sizeBytes: stored.size,
    })
    return Response.json(
      { documentId, filename: stored.filename },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "File could not be attached.",
      },
      { status: 400 }
    )
  }
}

/** Serves PDF/text inline; other originals download without executing uploaded content. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const projectId = url.searchParams.get("projectId") as Id<"projects"> | null
    const documentId = url.searchParams.get(
      "documentId"
    ) as Id<"chatDocuments"> | null
    if (!projectId || !documentId) throw new Error("File not found.")
    const document = await client().query(api.chatCitations.getDocument, {
      projectId,
      documentId,
    })
    if (!document) throw new Error("File not found.")
    const bytes = await readProjectFileBytes(
      projectId,
      document.relativeKey,
      50_000_000
    )
    const inline = ["application/pdf", "text/plain"].includes(document.mimeType)
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": document.mimeType,
        "content-length": String(bytes.byteLength),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    })
  } catch {
    return Response.json(
      {
        error:
          "Original file is unavailable. You can still read the saved passage.",
      },
      { status: 404 }
    )
  }
}
