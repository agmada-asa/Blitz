/**
 * Owns the local filesystem boundary for project files.
 *
 * Project directories are derived from the Convex project ID, while file keys
 * remain relative and are checked before every read or write. Uploads are
 * written to a sibling temporary file and renamed into place only after the
 * complete stream has been hashed.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  constants,
  createWriteStream,
  promises as fs,
  type Stats,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"

/** Environment variable used to isolate development and test data. */
export const DATA_ROOT_ENV = "BLITZ_DATA_DIR"
/** Directory under the data root containing one directory per project. */
export const PROJECTS_DIRECTORY = "Projects"
/** Directories that callers may not address through a stored file key. */
export const RESERVED_DIRECTORY_NAMES = new Set([".blitz"])

/** Result returned after an upload is atomically stored. */
export type StoredProjectFile = {
  key: string
  path: string
  size: number
  sha256: string
}

/** Returns the configured absolute data root, defaulting to the user's Documents folder. */
export function getDataRoot(): string {
  const configured = process.env[DATA_ROOT_ENV]?.trim()
  // User files are runtime data and must not be bundled into the Next server.
  return resolve(
    /* turbopackIgnore: true */ configured ||
      join(homedir(), "Documents", "Blitz")
  )
}

/** Returns a stable, collision-resistant directory path for a Convex project. */
export function getProjectDirectory(projectId: string, title?: string): string {
  assertProjectId(projectId)
  const idHash = createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, 24)
  // The ID hash is the complete identity of the directory. Titles can change
  // without moving a user's files, while the optional slug remains useful in
  // the API for callers that want to display it.
  void title
  return join(getDataRoot(), PROJECTS_DIRECTORY, `project-${idHash}`)
}

/** Validates the project identifier before it participates in filesystem paths. */
function assertProjectId(projectId: string): void {
  if (!projectId || projectId.includes("\0") || projectId.includes("/"))
    throw new Error("Project ID is invalid")
}

/** Validates and normalizes a relative project file key. */
export function normalizeProjectFileKey(fileKey: string): string {
  if (typeof fileKey !== "string" || !fileKey || fileKey.includes("\0"))
    throw new Error("File key is required")
  if (isAbsolute(fileKey)) throw new Error("File key must be relative")
  if (/^[A-Za-z]:[\\/]/.test(fileKey))
    throw new Error("File key must be relative")
  const normalized = fileKey.replaceAll("\\", "/")
  const parts = normalized.split("/")
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("File key contains an invalid path segment")
  if (parts.some((part) => RESERVED_DIRECTORY_NAMES.has(part.toLowerCase())))
    throw new Error("File key targets a reserved directory")
  const key = parts.join("/")
  if (key === "" || key.startsWith("/") || key.includes("//"))
    throw new Error("File key is invalid")
  return key
}

/** Ensures a project root exists and is a real directory rather than a symlink. */
export async function ensureProjectDirectory(
  projectId: string,
  title?: string
): Promise<string> {
  const projectDirectory = getProjectDirectory(projectId, title)
  const dataRoot = getDataRoot()
  const projectsRoot = join(dataRoot, PROJECTS_DIRECTORY)
  await assertExistingPathHasNoSymlinks(dataRoot)
  await assertExistingPathHasNoSymlinks(projectsRoot)
  await fs.mkdir(projectsRoot, { recursive: true })
  for (const directory of [dataRoot, projectsRoot]) {
    const ancestor = await fs.lstat(directory)
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
      throw new Error("Project data root is not a safe directory")
  }
  await fs.mkdir(projectDirectory, { recursive: true })
  const stat = await fs.lstat(projectDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Project directory is not a safe directory")
  return projectDirectory
}

/** Rejects symlink ancestors before any recursive directory creation can follow them. */
async function assertExistingPathHasNoSymlinks(target: string): Promise<void> {
  const absoluteTarget = resolve(target)
  const parsedRoot = absoluteTarget.startsWith(sep) ? sep : ""
  let current = parsedRoot
  for (const part of absoluteTarget
    .slice(parsedRoot.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current || parsedRoot, part)
    try {
      const entry = await fs.lstat(current)
      if (entry.isSymbolicLink()) {
        const resolved = await fs.realpath(current)
        const platformAlias =
          (current === "/tmp" && resolved === "/private/tmp") ||
          (current === "/var" && resolved === "/private/var")
        if (!platformAlias)
          throw new Error("Project data paths may not use symlinks")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

/** Checks every existing path component below a project root for symlinks. */
async function assertSafePath(
  projectRoot: string,
  target: string
): Promise<void> {
  const root = resolve(projectRoot)
  const targetPath = resolve(target)
  const outside = relative(root, targetPath)
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))
    throw new Error("Path escapes the project directory")
  const parts = outside ? outside.split(sep) : []
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let entry: Stats | undefined
    try {
      entry = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
    if (entry.isSymbolicLink())
      throw new Error("Project paths may not use symlinks")
    if (!entry.isDirectory() && current !== targetPath)
      throw new Error("A project path component is not a directory")
  }
}

/** Resolves a stored key inside one project after applying traversal and symlink checks. */
export async function resolveProjectFile(
  projectId: string,
  fileKey: string,
  title?: string
): Promise<string> {
  const key = normalizeProjectFileKey(fileKey)
  const projectRoot = await ensureProjectDirectory(projectId, title)
  const filePath = resolve(projectRoot, ...key.split("/"))
  await assertSafePath(projectRoot, filePath)
  return filePath
}

/** Streams content into a project file, returning its size and SHA-256 after an atomic rename. */
export async function storeProjectFile(
  projectId: string,
  fileKey: string,
  input: AsyncIterable<Uint8Array> | Readable | Uint8Array | string,
  title?: string
): Promise<StoredProjectFile> {
  const key = normalizeProjectFileKey(fileKey)
  const filePath = await resolveProjectFile(projectId, key, title)
  const parent = dirname(filePath)
  const projectRoot = getProjectDirectory(projectId, title)
  await assertSafePath(projectRoot, parent)
  await fs.mkdir(parent, { recursive: true })
  await assertSafePath(projectRoot, parent)
  const temporaryPath = join(
    parent,
    `.${randomBytes(16).toString("hex")}.uploading`
  )
  const hash = createHash("sha256")
  let size = 0
  const source =
    typeof input === "string" || input instanceof Uint8Array
      ? Readable.from([input])
      : Readable.from(input)
  const hashing = new TransformHash(hash, (chunk) => {
    size += chunk.length
  })
  try {
    await pipeline(
      source,
      hashing,
      createWriteStream(temporaryPath, { flags: "wx" })
    )
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
  return { key, path: filePath, size, sha256: hash.digest("hex") }
}

/** Small transform that hashes bytes while preserving the upload stream. */
class TransformHash extends Transform {
  private readonly hash: ReturnType<typeof createHash>
  private readonly onChunk: (chunk: Buffer) => void

  /** Creates the hashing transform and records each chunk's byte count. */
  constructor(
    hash: ReturnType<typeof createHash>,
    onChunk: (chunk: Buffer) => void
  ) {
    super()
    this.hash = hash
    this.onChunk = onChunk
  }

  /** Hashes and forwards one chunk, preserving backpressure. */
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void
  ): void {
    this.hash.update(chunk)
    this.onChunk(chunk)
    this.push(chunk)
    callback(undefined)
  }
}

/** Reads a regular project file through a no-follow descriptor under a hard byte bound. */
export async function readProjectFileBytes(
  projectId: string,
  key: string,
  maximumBytes: number
): Promise<Buffer> {
  const path = await resolveProjectFile(projectId, key)
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximumBytes)
      throw new Error("File is not a regular file within the size limit")
    const bytes = Buffer.alloc(Math.min(maximumBytes + 1, info.size + 1))
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      )
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset > info.size || offset > maximumBytes)
      throw new Error("File changed while reading; try again")
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Removes one previously stored file after a failed ingestion step. */
export async function removeProjectFile(
  projectId: string,
  key: string
): Promise<void> {
  const path = await resolveProjectFile(projectId, key)
  await fs.rm(path, { force: true })
}
