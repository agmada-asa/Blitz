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
  storeProjectFile,
  streamProjectFile,
} from "@/lib/server/project-files"
import {
  extractLongPdfText,
  extractStoredSource,
} from "@/lib/server/source-ingestion/extract"
import { SourceIngestionError } from "@/lib/server/source-ingestion/errors"
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

/** Human-readable size string used for file descriptors. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolves an appropriate MIME type from the upload header or file extension. */
function inferMimeType(filename: string, candidate: string | null): string {
  const normalized = candidate?.split(";", 1)[0].trim().toLowerCase()
  if (normalized && normalized !== "application/octet-stream") return normalized
  if (/\.pdf$/i.test(filename)) return "application/pdf"
  if (/\.pptx$/i.test(filename))
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  if (/\.json$/i.test(filename)) return "application/json"
  if (/\.csv$/i.test(filename)) return "text/csv"
  if (/\.html?$/i.test(filename)) return "text/html"
  if (/\.(md|markdown)$/i.test(filename)) return "text/markdown"
  if (
    /\.(txt|py|ts|tsx|js|jsx|sh|bash|zsh|yaml|yml|toml|xml|css|sql|rs|go|c|cpp|h|java|kt|rb|php|env)$/i.test(
      filename
    )
  )
    return "text/plain"
  return "application/octet-stream"
}

/** Connects to the same personal deployment as the chat route. */
function client(): ConvexHttpClient {
  const url =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!url) throw new Error("Chat files are unavailable")
  return new ConvexHttpClient(url)
}

/** Characters of extracted text kept in the stored preview once the full text is too large. */
const TEXT_PREVIEW_CHARACTERS = 100_000

/**
 * Saves any original and records bounded text when extraction is practical.
 *
 * Structured documents whose text is too large for the stored preview, such as
 * whole textbooks, also get their full page-marked text saved beside the
 * original. The chat agent receives that file so it can search the whole
 * document instead of only the preview.
 */
export async function POST(request: Request): Promise<Response> {
  let cleanup:
    | { storageId: string; key: string; textKey?: string; remove: boolean }
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
    const convex = client()
    if (projectId && !(await convex.query(api.projects.getProject, { projectId })))
      throw new Error("Project not found.")
    const stored = projectId
      ? await storeOriginalSource({ projectId, filename, body: request.body, mimeType: request.headers.get("content-type") })
      : await storeOriginalChatUpload({ ownerToken: ownerToken!, filename, body: request.body, mimeType: request.headers.get("content-type") })
    const storageId = projectId ?? chatStorageId(ownerToken!)
    cleanup = {
      storageId,
      key: stored.key,
      remove: projectId ? !("duplicate" in stored && stored.duplicate) : true,
    }
    const storedPath = await resolveProjectFile(storageId, stored.key)
    const contentType = request.headers.get("content-type")
    const imageAttachment = isImageAttachment(filename, contentType)
    let isNativeImage = false
    if (imageAttachment) {
      const claimedMimeType = contentType?.split(";", 1)[0].trim().toLowerCase()
      if (isChatImageMimeType(claimedMimeType)) {
        try {
          const imageBytes = new Uint8Array(
            await readProjectFileBytes(storageId, stored.key, 5_000_000)
          )
          validateChatImageBytes(imageBytes, claimedMimeType)
          isNativeImage = true
        } catch {
          isNativeImage = false
        }
      }
    }

    let extractedText = ""
    if (isNativeImage) {
      extractedText = `[Image attachment: ${stored.filename}]`
    } else {
      const isStructuredDoc = /\.(pdf|pptx|html?|md|markdown)$/i.test(filename)
      if (isStructuredDoc) {
        try {
          const result = await extractStoredSource({
            path: storedPath,
            filename: stored.filename,
            sizeBytes: stored.size,
            contentType: stored.mimeType,
          })
          if (result.extractedText.trim()) {
            extractedText = result.extractedText
          }
        } catch (error) {
          // Long PDFs exceed source import bounds but can still be read in chat.
          if (
            /\.pdf$/i.test(filename) &&
            error instanceof SourceIngestionError &&
            error.code === "input-too-large"
          ) {
            try {
              extractedText = await extractLongPdfText(storedPath)
            } catch {
              // Fall back to the descriptor; the agent can still open the original.
            }
          }
          // Other failures fall back to text sampling or a file descriptor.
        }
      }

      if (!extractedText) {
        try {
          const sampleBytes = new Uint8Array(
            await readProjectFileBytes(storageId, stored.key, 500_000)
          )
          const hasNullByte = sampleBytes.some((byte) => byte === 0)
          if (!hasNullByte) {
            const decoded = new TextDecoder("utf-8", { fatal: true })
              .decode(sampleBytes)
              .trim()
            if (decoded) {
              if (stored.size > sampleBytes.byteLength) {
                extractedText = `${decoded.slice(0, 480_000)}\n[remaining text preview omitted; full file (${formatFileSize(stored.size)}) available in workspace]`
              } else {
                extractedText = decoded.slice(0, 480_000)
              }
            }
          }
        } catch {
          // Binary or non-UTF-8 files proceed to descriptor fallback.
        }
      }

      if (!extractedText.trim()) {
        extractedText = `[Attached file: ${stored.filename} (${formatFileSize(stored.size)})]`
      }
    }

    let textKey: string | undefined
    if (new TextEncoder().encode(extractedText).length > 500_000) {
      const isExtractedDocument =
        !isNativeImage && /\.(pdf|pptx|html?|md|markdown)$/i.test(filename)
      if (isExtractedDocument) {
        // Plain text originals are already searchable; extracted text is not.
        textKey = `${stored.key.split("/")[0]}/${stored.sha256}.pages.txt`
        await storeProjectFile(storageId, textKey, extractedText)
        cleanup.textKey = textKey
      }
      extractedText = `${extractedText.slice(0, TEXT_PREVIEW_CHARACTERS)}${
        textKey
          ? "\n[Preview ends here. The full page-marked text is in a separate attached file.]"
          : ""
      }`
    }

    const mimeType = isNativeImage
      ? contentType?.split(";", 1)[0].trim().toLowerCase() ||
        stored.mimeType ||
        "application/octet-stream"
      : inferMimeType(filename, contentType || stored.mimeType)

    const documentId = await convex.mutation(api.chatCitations.createDocument, {
      ...(projectId ? { projectId } : {}),
      ...(!projectId && ownerToken ? { ownerToken } : {}),
      filename: stored.filename,
      relativeKey: stored.key,
      ...(textKey ? { textKey } : {}),
      text: extractedText,
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
      if (cleanup.textKey)
        await removeProjectFile(cleanup.storageId, cleanup.textKey).catch(
          () => undefined
        )
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
    const file = await streamProjectFile(
      storageId,
      document.relativeKey
    )
    const inline =
      ["application/pdf", "text/plain"].includes(document.mimeType) ||
      document.mimeType.startsWith("image/")
    return new Response(file.body, {
      headers: {
        "content-type": document.mimeType,
        "content-length": String(file.size),
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
