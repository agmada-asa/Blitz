/** Stores original sources through the shared project filesystem boundary. */

import { createHash, randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { basename, join, relative } from "node:path"
import { Readable } from "node:stream"

import {
  getProjectDirectory,
  resolveProjectFile,
  storeProjectFile,
} from "./project-files.ts"

/** Durable metadata returned after an upload is stored or deduplicated. */
export interface StoredSourceFile {
  readonly key: string
  readonly sha256: string
  readonly size: number
  readonly mimeType: string | null
  readonly filename: string
  readonly duplicate: boolean
}

/** Durable metadata returned for a projectless chat upload. */
export interface StoredChatFile {
  readonly key: string
  readonly sha256: string
  readonly size: number
  readonly mimeType: string | null
  readonly filename: string
}

/** Converts an untrusted client filename to one safe relative path segment. */
export function safeSourceFilename(filename: string): string {
  const candidate =
    basename(filename.replaceAll("\\", "/"))
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || "source.bin"
  // The content hash and separator also occupy bytes in the filesystem segment.
  const extension = candidate.match(/\.[^.]{1,20}$/)?.[0] ?? ""
  const suffix = Buffer.byteLength(extension) <= 24 ? extension : ""
  const stem = suffix ? candidate.slice(0, -suffix.length) : candidate
  let safeStem = ""
  for (const character of stem) {
    if (Buffer.byteLength(safeStem + character + suffix) > 190) break
    safeStem += character
  }
  return (safeStem || "source") + suffix
}

/** Adapts a web request body to the streaming project file store. */
async function* sourceChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Stores one request stream atomically, deduplicating exact content within a project. */
export async function storeOriginalSource(input: {
  projectId: string
  filename: string
  mimeType?: string | null
  body: ReadableStream<Uint8Array>
}): Promise<StoredSourceFile> {
  const filename = safeSourceFilename(input.filename)
  const temporaryKey = `Sources/.upload-${randomBytes(12).toString("hex")}`
  const stored = await storeProjectFile(
    input.projectId,
    temporaryKey,
    Readable.from(sourceChunks(input.body)),
  )
  if (!stored.size) {
    await fs.rm(stored.path, { force: true })
    throw new Error("Source upload is empty")
  }
  const sourcesDirectory = join(getProjectDirectory(input.projectId), "Sources")
  const existing = (await fs.readdir(sourcesDirectory)).find((entry) => entry.startsWith(`${stored.sha256}-`))
  if (existing) {
    await fs.rm(stored.path, { force: true })
    return {
      key: relative(getProjectDirectory(input.projectId), join(sourcesDirectory, existing)),
      sha256: stored.sha256,
      size: stored.size,
      mimeType: input.mimeType?.trim() || null,
      filename,
      duplicate: true,
    }
  }
  const durableKey = `Sources/${stored.sha256}-${filename}`
  const durablePath = await resolveProjectFile(input.projectId, durableKey)
  await fs.rename(stored.path, durablePath)
  return {
    key: durableKey,
    sha256: stored.sha256,
    size: stored.size,
    mimeType: input.mimeType?.trim() || null,
    filename,
    duplicate: false,
  }
}

/** Derives an isolated filesystem identity from an opaque pre-chat upload token. */
export function chatStorageId(ownerToken: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken))
    throw new Error("Chat upload token is invalid")
  return `chat-${createHash("sha256").update(ownerToken).digest("hex")}`
}

/** Stores a projectless chat upload below the server-owned chat upload directory. */
export async function storeOriginalChatUpload(input: {
  ownerToken: string
  filename: string
  mimeType?: string | null
  body: ReadableStream<Uint8Array>
}): Promise<StoredChatFile> {
  const storageId = chatStorageId(input.ownerToken)
  const filename = safeSourceFilename(input.filename)
  const temporaryKey = `Uploads/.upload-${randomBytes(12).toString("hex")}`
  const stored = await storeProjectFile(
    storageId,
    temporaryKey,
    Readable.from(sourceChunks(input.body))
  )
  if (!stored.size) {
    await fs.rm(stored.path, { force: true })
    throw new Error("Source upload is empty")
  }
  const durableKey = `Uploads/${stored.sha256}-${filename}`
  const durablePath = await resolveProjectFile(storageId, durableKey)
  await fs.rename(stored.path, durablePath)
  return {
    key: durableKey,
    sha256: stored.sha256,
    size: stored.size,
    mimeType: input.mimeType?.trim() || null,
    filename,
  }
}

/** Exports legacy extracted text as an explicitly labelled derived source file. */
export async function exportLegacyDerivedSource(input: {
  projectId: string
  filename: string
  text: string
}): Promise<{ key: string; size: number }> {
  const safeName = safeSourceFilename(input.filename).replace(/\.[^.]+$/, "")
  const key = `Sources/legacy-derived-${safeName}.txt`
  const payload = Buffer.from(`LEGACY DERIVED TEXT\n${input.text.trim()}\n`, "utf8")
  const stored = await storeProjectFile(input.projectId, key, payload)
  return { key: stored.key, size: stored.size }
}

/** Returns the size of a safe stored source key for diagnostics and restart checks. */
export async function sourceFileStats(projectId: string, key: string): Promise<number> {
  const path = await resolveProjectFile(projectId, key)
  return (await fs.stat(path)).size
}
