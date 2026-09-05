/** Stores bounded original sources through the shared project filesystem boundary. */

import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { basename, join, relative } from "node:path"
import { Readable } from "node:stream"

import {
  getProjectDirectory,
  resolveProjectFile,
  storeProjectFile,
} from "./project-files.ts"

/** Maximum original upload size accepted by local desktop and Android clients. */
export const MAX_ORIGINAL_SOURCE_BYTES = 50_000_000

/** Durable metadata returned after an upload is stored or deduplicated. */
export interface StoredSourceFile {
  readonly key: string
  readonly sha256: string
  readonly size: number
  readonly mimeType: string | null
  readonly filename: string
  readonly duplicate: boolean
}

/** Converts an untrusted client filename to one safe relative path segment. */
export function safeSourceFilename(filename: string): string {
  const candidate = basename(filename).replace(/[\u0000-\u001f\u007f]/g, "").trim() || "source.bin"
  return candidate.slice(0, 255)
}

/** Adapts a web stream while enforcing the byte limit before yielding an oversized chunk. */
async function* boundedChunks(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      size += next.value.byteLength
      if (size > maxBytes) throw new Error("Source upload exceeds the size limit")
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
  maxBytes?: number
}): Promise<StoredSourceFile> {
  const filename = safeSourceFilename(input.filename)
  const temporaryKey = `Sources/.upload-${randomBytes(12).toString("hex")}`
  const stored = await storeProjectFile(
    input.projectId,
    temporaryKey,
    Readable.from(boundedChunks(input.body, input.maxBytes ?? MAX_ORIGINAL_SOURCE_BYTES)),
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

/** Exports legacy extracted text as an explicitly labelled derived source file. */
export async function exportLegacyDerivedSource(input: {
  projectId: string
  filename: string
  text: string
}): Promise<{ key: string; size: number }> {
  const safeName = safeSourceFilename(input.filename).replace(/\.[^.]+$/, "")
  const key = `Sources/legacy-derived-${safeName}.txt`
  const payload = Buffer.from(`LEGACY DERIVED TEXT\n${input.text.trim()}\n`, "utf8")
  if (payload.byteLength > MAX_ORIGINAL_SOURCE_BYTES) throw new Error("Derived source exceeds the size limit")
  const stored = await storeProjectFile(input.projectId, key, payload)
  return { key: stored.key, size: stored.size }
}

/** Returns the size of a safe stored source key for diagnostics and restart checks. */
export async function sourceFileStats(projectId: string, key: string): Promise<number> {
  const path = await resolveProjectFile(projectId, key)
  return (await fs.stat(path)).size
}
