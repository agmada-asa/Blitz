/**
 * Files a workspace chat turn works with: the folder the agent runs in, the
 * uploaded files it reads, and the images it hands the provider natively.
 */

import type { ConvexHttpClient } from "convex/browser"
import { constants as fileConstants } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { api } from "../../../convex/_generated/api.js"
import type { Id } from "../../../convex/_generated/dataModel.js"
import {
  CHAT_IMAGE_MIME_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  type ChatImageMimeType,
} from "../chat-attachments.ts"
import { readProjectFileBytes, resolveProjectFile } from "../project-files.ts"
import type { ProviderImageAttachment } from "../providers/types.ts"
import { chatStorageId, safeSourceFilename } from "../source-files.ts"
import type {
  WorkspaceChatInlineAttachment,
  WorkspaceChatRequest,
} from "../workspace-chat.ts"

/** Project and chat that may own a turn's saved documents. */
export type AttachmentOwners = {
  ownerProjectId?: Id<"projects">
  chatId?: Id<"workspaceChats">
}

/** Most image bytes one turn hands a provider natively, across all its images. */
const MAX_TURN_IMAGE_BYTES = 20_000_000

/** Images a turn hands the provider natively, and which documents they came from. */
export type NativeImages = {
  images: ProviderImageAttachment[]
  bytes: number
  documentIds: Set<Id<"chatDocuments">>
}

/** Resolves and creates the dedicated local folder used for general chat turns. */
export async function chatWorkspaceDirectory(chatId: string): Promise<string> {
  const directory = join(
    process.env.BLITZ_CODEX_WORKSPACE?.trim() ||
      join(homedir(), ".local", "share", "blitz", "codex-workspace"),
    chatId
  )
  if (!isAbsolute(directory))
    throw new Error("Chat workspace must be an absolute path")
  await mkdir(directory, { recursive: true })
  return directory
}

/**
 * Finds one attached chat document using the strongest ownership proof available.
 *
 * Draft uploads carry an owner token and stay unbound until the turn starts, so
 * the token is tried first. That keeps a file attached before the learner picks a
 * project readable after the chat joins that project. Project and chat ownership
 * cover files saved by earlier turns.
 *
 * @param client - Convex client for the personal deployment.
 * @param attachment - Submitted attachment with its document ID and optional token.
 * @param owners - Project and chat that may own the stored document.
 * @returns The owned document, or null when no ownership proof matches.
 */
async function findAttachmentDocument(
  client: ConvexHttpClient,
  attachment: { documentId?: Id<"chatDocuments">; ownerToken?: string },
  owners: AttachmentOwners
) {
  const documentId = attachment.documentId
  if (!documentId) return null
  const candidates = [
    ...(attachment.ownerToken
      ? [
          {
            ownerToken: attachment.ownerToken,
            ...(owners.chatId ? { chatId: owners.chatId } : {}),
          },
          { ownerToken: attachment.ownerToken },
        ]
      : []),
    ...(owners.ownerProjectId ? [{ projectId: owners.ownerProjectId }] : []),
    ...(owners.chatId ? [{ chatId: owners.chatId }] : []),
  ]
  for (const ownership of candidates) {
    const document = await client.query(api.chatCitations.getDocument, {
      documentId,
      ...ownership,
    })
    if (document) return document
  }
  return null
}

/** Copies attached chat documents into the workspace under attachments/ and annotates them with paths. */
export async function stageWorkspaceAttachments(
  client: ConvexHttpClient,
  workspaceDirectory: string,
  attachments: WorkspaceChatInlineAttachment[],
  owners: AttachmentOwners = {}
): Promise<void> {
  const attachmentsDir = join(workspaceDirectory, "attachments")
  let dirCreated = false

  for (const attachment of attachments) {
    if (!attachment.documentId) continue
    const document = await findAttachmentDocument(client, attachment, owners)
    if (!document) continue

    const storageId =
      document.projectId ??
      (document.ownerToken ? chatStorageId(document.ownerToken) : null)
    if (!storageId) continue

    try {
      const sourcePath = await resolveProjectFile(storageId, document.relativeKey)
      if (!dirCreated) {
        await mkdir(attachmentsDir, { recursive: true })
        dirCreated = true
      }
      const targetName = `${document._id}-${safeSourceFilename(document.filename)}`
      const targetPath = join(attachmentsDir, targetName)

      if (resolve(sourcePath) !== resolve(targetPath)) {
        // Clone on supporting filesystems so large attachments need no second full copy.
        await copyFile(sourcePath, targetPath, fileConstants.COPYFILE_FICLONE)
      }
      attachment.workspacePath = join("attachments", targetName)
      attachment.filePath = targetPath
      if (document.textKey) {
        // The inline text is only a preview; give the agent the whole document.
        const textName = `${document._id}-${safeSourceFilename(document.filename)}.pages.txt`
        const textSource = await resolveProjectFile(storageId, document.textKey)
        await copyFile(
          textSource,
          join(attachmentsDir, textName),
          fileConstants.COPYFILE_FICLONE
        )
        attachment.textWorkspacePath = join("attachments", textName)
      }
    } catch {
      throw new Error(`Could not make ${document.filename} available in chat.`)
    }
  }
}

/**
 * Whether a saved document's MIME type is exactly one of the native image
 * formats, as the upload route stores them.
 */
function isStoredImageMimeType(
  mimeType: string | undefined
): mimeType is ChatImageMimeType {
  return CHAT_IMAGE_MIME_TYPES.some((type) => type === mimeType)
}

/**
 * Fills in this turn's uploaded files from their saved documents. Each file's
 * text replaces what the browser sent, within a shared 96,000-character budget
 * (24,000 per file), and images small enough are also read for the provider to
 * see natively.
 *
 * @param client - Convex client for the personal deployment.
 * @param attachments - The request's attachments; file entries are updated in place.
 * @param owners - Project and chat that may own the saved documents.
 * @returns The native images, their total size, and every uploaded document
 *   this turn sent, so replayed history does not add them twice.
 * @throws When a file is missing or not owned by this chat, or an image's storage is unavailable.
 */
export async function resolveSubmittedAttachments(
  client: ConvexHttpClient,
  attachments: WorkspaceChatRequest["attachments"],
  owners: AttachmentOwners
): Promise<NativeImages> {
  const images: ProviderImageAttachment[] = []
  let imageBytes = 0
  let attachmentBudget = Math.max(
    0,
    96_000 -
      attachments.reduce((sum, attachment) => sum + attachment.text.length, 0)
  )
  for (const attachment of attachments) {
    if (!attachment.documentId) continue
    const document = await findAttachmentDocument(client, attachment, owners)
    if (!document)
      throw new Error("Attached file was not found or is not owned by this chat")
    attachment.label = document.filename
    if (
      document.sizeBytes <= MAX_CHAT_IMAGE_BYTES &&
      imageBytes + document.sizeBytes <= MAX_TURN_IMAGE_BYTES &&
      isStoredImageMimeType(document.mimeType)
    ) {
      attachment.mimeType = document.mimeType
      const storageId =
        document.projectId ??
        (document.ownerToken ? chatStorageId(document.ownerToken) : null)
      if (!storageId) throw new Error("Attached file storage is unavailable")
      const bytes = await readProjectFileBytes(
        storageId,
        document.relativeKey,
        MAX_CHAT_IMAGE_BYTES
      )
      imageBytes += bytes.byteLength
      images.push({
        type: "image",
        mimeType: document.mimeType,
        data: Buffer.from(bytes).toString("base64"),
        name: document.filename,
      })
    }
    attachment.text = document.text.slice(0, Math.min(24_000, attachmentBudget))
    if (!attachment.text) attachment.text = `[Attached file: ${document.filename}]`
    attachmentBudget = Math.max(0, attachmentBudget - attachment.text.length)
  }
  return {
    images,
    bytes: imageBytes,
    documentIds: new Set(
      attachments
        .map((attachment) => attachment.documentId)
        .filter((id): id is Id<"chatDocuments"> => Boolean(id))
    ),
  }
}

/**
 * Adds images from earlier turns to `native`, within the same size limits.
 * Only needed when a provider session is rebuilt, because a new session does
 * not have the images an old one was shown.
 *
 * @param client - Convex client for the personal deployment.
 * @param attachments - Attachments saved on earlier turns.
 * @param owners - The chat's project, else the chat, that owns them.
 * @param native - This turn's images; updated in place.
 */
export async function appendReplayImages(
  client: ConvexHttpClient,
  attachments: readonly WorkspaceChatInlineAttachment[],
  owners: AttachmentOwners,
  native: NativeImages
): Promise<void> {
  for (const attachment of attachments) {
    if (
      !attachment.documentId ||
      native.documentIds.has(attachment.documentId) ||
      !isStoredImageMimeType(attachment.mimeType)
    )
      continue
    const document = await client.query(api.chatCitations.getDocument, {
      documentId: attachment.documentId,
      ...(owners.ownerProjectId
        ? { projectId: owners.ownerProjectId }
        : owners.chatId
          ? { chatId: owners.chatId }
          : {}),
    })
    if (!document) continue
    if (
      document.sizeBytes > MAX_CHAT_IMAGE_BYTES ||
      native.bytes + document.sizeBytes > MAX_TURN_IMAGE_BYTES
    )
      continue
    const storageId =
      document.projectId ??
      (document.ownerToken ? chatStorageId(document.ownerToken) : null)
    if (!storageId) continue
    const bytes = await readProjectFileBytes(
      storageId,
      document.relativeKey,
      MAX_CHAT_IMAGE_BYTES
    )
    native.bytes += bytes.byteLength
    native.documentIds.add(attachment.documentId)
    native.images.push({
      type: "image",
      mimeType: attachment.mimeType,
      data: Buffer.from(bytes).toString("base64"),
      name: document.filename,
    })
  }
}
