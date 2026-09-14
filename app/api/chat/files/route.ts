/** Stores ad hoc chat originals and serves them through owned document IDs. */
import { ConvexHttpClient } from "convex/browser"
import { randomBytes } from "node:crypto"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import {
  chatStorageId,
  storeOriginalChatUpload,
  storeOriginalSource,
} from "@/lib/server/source-files"
import {
  removeProjectFile,
  readProjectFileBytes,
  resolveProjectFile,
} from "@/lib/server/project-files"
import { extractStoredSource } from "@/lib/server/source-ingestion/extract"
import {
  isChatImageMimeType,
  validateChatImageBytes,
} from "@/lib/server/chat-attachments"

/** Returns whether an upload is a supported native image attachment. */
function isImageAttachment(filename: string, mimeType: string | null): boolean {
  const normalized = mimeType?.split(";", 1)[0].trim().toLowerCase() ?? ""
  return (
    isChatImageMimeType(normalized) || /\.(png|jpe?g|webp|gif)$/i.test(filename)
  )
}

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
  let cleanup:
    | { storageId: string; key: string; remove: boolean }
    | undefined
  try {
    if (!isTrustedBlitzOrigin(request))
      return Response.json(
        { error: "Open Blitz to attach a file." },
        { status: 403 }
      )
    const projectId = request.headers.get("x-blitz-project-id") as Id<"projects"> | null
    let ownerToken = request.headers.get("x-blitz-chat-upload-token")
    if (!projectId && !ownerToken)
      ownerToken = randomBytes(32).toString("base64url")
    const filename = decodeURIComponent(
      request.headers.get("x-blitz-filename") ?? ""
    )
    if ((!projectId && !ownerToken) || !filename || !request.body)
      throw new Error("File owner and file are required.")
    const contentType = request.headers.get("content-type")
    const imageAttachment = isImageAttachment(filename, contentType)
    if (!imageAttachment && !/\.(pdf|md|markdown|txt|pptx)$/i.test(filename))
      throw new Error(
        "Choose an image, PDF, PowerPoint, Markdown, or text file."
      )
    if (Number(request.headers.get("content-length")) > 50_000_000)
      throw new Error("Chat files must be under 50 MB.")
    const convex = client()
    if (projectId && !(await convex.query(api.projects.getProject, { projectId })))
      throw new Error("Project not found.")
    const stored = projectId
      ? await storeOriginalSource({ projectId, filename, body: request.body, mimeType: request.headers.get("content-type"), maxBytes: 50_000_000 })
      : await storeOriginalChatUpload({ ownerToken: ownerToken!, filename, body: request.body, mimeType: request.headers.get("content-type"), maxBytes: 50_000_000 })
    const storageId = projectId ?? chatStorageId(ownerToken!)
    cleanup = {
      storageId,
      key: stored.key,
      remove: projectId ? !("duplicate" in stored && stored.duplicate) : true,
    }
    const storedPath = await resolveProjectFile(storageId, stored.key)
    if (imageAttachment) {
      const claimedMimeType = contentType?.split(";", 1)[0].trim().toLowerCase()
      if (!isChatImageMimeType(claimedMimeType))
        throw new Error("Image MIME type is required.")
      validateChatImageBytes(
        new Uint8Array(
          await readProjectFileBytes(storageId, stored.key, 50_000_000)
        ),
        claimedMimeType
      )
    }
    const extracted = imageAttachment
      ? { extractedText: `[Image attachment: ${stored.filename}]` }
      : await extractStoredSource({
          path: storedPath,
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
    const mimeType = imageAttachment
      ? contentType?.split(";", 1)[0].trim().toLowerCase() ||
        stored.mimeType ||
        "application/octet-stream"
      : /\.pdf$/i.test(filename)
        ? "application/pdf"
        : /\.pptx$/i.test(filename)
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          : "text/plain"
    const documentId = await convex.mutation(api.chatCitations.createDocument, {
      ...(projectId ? { projectId } : {}),
      ...(!projectId && ownerToken ? { ownerToken } : {}),
      filename: stored.filename,
      relativeKey: stored.key,
      text: extracted.extractedText,
      mimeType,
      sizeBytes: stored.size,
    })
    return Response.json(
      {
        documentId,
        filename: stored.filename,
        mimeType,
        ...(!projectId && ownerToken ? { ownerToken } : {}),
      },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    if (cleanup?.remove) {
      await removeProjectFile(cleanup.storageId, cleanup.key).catch(() => undefined)
    }
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
    const chatId = url.searchParams.get("chatId") as Id<"workspaceChats"> | null
    const ownerToken = url.searchParams.get("ownerToken")
    const documentId = url.searchParams.get(
      "documentId"
    ) as Id<"chatDocuments"> | null
    if (!documentId || (!projectId && !chatId && !ownerToken))
      throw new Error("File not found.")
    const document = await client().query(api.chatCitations.getDocument, {
      documentId,
      ...(projectId ? { projectId } : {}),
      ...(chatId ? { chatId } : {}),
      ...(ownerToken ? { ownerToken } : {}),
    })
    if (!document) throw new Error("File not found.")
    const storageId =
      document.projectId ??
      (document.ownerToken ? chatStorageId(document.ownerToken) : null)
    if (!storageId) throw new Error("File not found.")
    const bytes = await readProjectFileBytes(
      storageId,
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
