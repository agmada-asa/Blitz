/**
 * Owns derived source text kept for review before retrieval indexing.
 *
 * Derived text lives under the project-private `.blitz` directory and is
 * represented by a small manifest. Only an explicit approval changes its
 * status to searchable; legacy exports are copied to Sources with a visible
 * derived label so they cannot be mistaken for original uploads.
 */
import { createHash, randomBytes } from "node:crypto"
import { constants, promises as fs } from "node:fs"
import { join } from "node:path"
import {
  ensureProjectDirectory,
  getProjectDirectory,
  storeProjectFile,
  type StoredProjectFile,
} from "./project-files.ts"

/** Maximum derived text size accepted for one cached item. */
export const MAX_DERIVED_TEXT_BYTES = 5 * 1024 * 1024
const DERIVED_DIRECTORY = ".blitz/derived"
const MANIFEST_FILE = "manifest.json"

/** Lifecycle state of a derived source item. */
export type DerivedSourceStatus = "pending" | "approved"
/** Metadata persisted for one derived source item. */
export type DerivedSource = {
  id: string
  sourceKey: string
  path: string
  sha256: string
  size: number
  status: DerivedSourceStatus
  createdAt: number
  approvedAt?: number
  uploadedAt?: number
}

/** Returns the private cache directory for a project. */
function derivedDirectory(projectId: string): string {
  return join(getProjectDirectory(projectId), DERIVED_DIRECTORY)
}

/** Creates the private cache directory without following a pre-existing symlink. */
async function ensureDerivedDirectory(projectId: string): Promise<string> {
  const projectRoot = await ensureProjectDirectory(projectId)
  const privateRoot = join(projectRoot, ".blitz")
  for (const directory of [privateRoot, derivedDirectory(projectId)]) {
    try {
      const entry = await fs.lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Derived cache path is not safe")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  await fs.mkdir(derivedDirectory(projectId), { recursive: true })
  return derivedDirectory(projectId)
}

/** Validates bounded, non-empty derived text. */
function validateText(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8")
  if (!bytes.length) throw new Error("Derived text cannot be empty")
  if (bytes.length > MAX_DERIVED_TEXT_BYTES)
    throw new Error("Derived text exceeds the size limit")
  return bytes
}

/** Reads the private manifest, treating a missing manifest as an empty cache. */
async function readManifest(projectId: string): Promise<DerivedSource[]> {
  await ensureDerivedDirectory(projectId)
  try {
    if (
      (
        await fs.lstat(join(derivedDirectory(projectId), MANIFEST_FILE))
      ).isSymbolicLink()
    )
      throw new Error("Derived manifest may not be a symlink")
    const parsed: unknown = JSON.parse(
      await fs.readFile(
        join(derivedDirectory(projectId), MANIFEST_FILE),
        "utf8"
      )
    )
    if (!Array.isArray(parsed)) throw new Error("Derived manifest is invalid")
    return parsed as DerivedSource[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/** Atomically replaces the private derived manifest. */
async function writeManifest(
  projectId: string,
  entries: DerivedSource[]
): Promise<void> {
  const directory = await ensureDerivedDirectory(projectId)
  const temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`)
  try {
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    })
    await fs.rename(temporary, join(directory, MANIFEST_FILE))
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

/** Caches derived text as pending and returns the stable item metadata. */
export async function cacheDerivedText(
  projectId: string,
  sourceKey: string,
  text: string
): Promise<DerivedSource> {
  const bytes = validateText(text)
  await ensureDerivedDirectory(projectId)
  const hash = createHash("sha256").update(bytes).digest("hex")
  const id = createHash("sha256")
    .update(`${sourceKey}\0${hash}`)
    .digest("hex")
    .slice(0, 24)
  const path = join(derivedDirectory(projectId), `${id}.txt`)
  await ensureDerivedDirectory(projectId)
  try {
    await fs.writeFile(path, bytes, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const entries = await readManifest(projectId)
  const existing = entries.find((entry) => entry.id === id)
  if (existing) return existing
  const entry: DerivedSource = {
    id,
    sourceKey,
    path,
    sha256: hash,
    size: bytes.byteLength,
    status: "pending",
    createdAt: Date.now(),
  }
  await writeManifest(projectId, [...entries, entry])
  return entry
}

/** Lists derived items without exposing their text or treating them as searchable. */
export async function listDerivedSources(
  projectId: string
): Promise<DerivedSource[]> {
  await ensureProjectDirectory(projectId)
  return readManifest(projectId)
}

/** Approves one pending item for downstream indexing and records the approval time. */
export async function approveDerivedSource(
  projectId: string,
  id: string
): Promise<DerivedSource> {
  const entries = await readManifest(projectId)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error("Derived source not found")
  const updated = {
    ...entries[index],
    status: "approved" as const,
    approvedAt: Date.now(),
  }
  entries[index] = updated
  await writeManifest(projectId, entries)
  return updated
}

/** Returns only approved items for an indexer, keeping pending text out of retrieval. */
export async function listApprovedDerivedSources(
  projectId: string
): Promise<DerivedSource[]> {
  return (await listDerivedSources(projectId)).filter(
    (entry) => entry.status === "approved"
  )
}

/** Reads one approved or pending derived item through its manifest-selected safe path. */
export async function readDerivedText(
  projectId: string,
  id: string
): Promise<string> {
  const item = (await listDerivedSources(projectId)).find(
    (entry) => entry.id === id
  )
  if (!item) throw new Error("Derived source not found")
  if (!/^[a-f0-9]{24}$/.test(item.id))
    throw new Error("Derived source ID is invalid")
  const handle = await fs.open(
    join(derivedDirectory(projectId), `${item.id}.txt`),
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  let text: string
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 120_000)
      throw new Error("Derived review text exceeds the display limit")
    text = await handle.readFile("utf8")
    if (
      Buffer.byteLength(text) > 120_000 ||
      createHash("sha256").update(text).digest("hex") !== item.sha256
    )
      throw new Error("Derived text changed; cache it again for review")
  } finally {
    await handle.close()
  }

  return text
}

/** Marks an approved item after its canonical source upload has been recorded. */
export async function markDerivedUploaded(
  projectId: string,
  id: string
): Promise<DerivedSource> {
  const entries = await readManifest(projectId)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error("Derived source not found")
  entries[index] = { ...entries[index], uploadedAt: Date.now() }
  await writeManifest(projectId, entries)
  return entries[index]
}

/** Exports legacy derived text into Sources with a label that identifies its provenance. */
export async function exportLegacyText(
  projectId: string,
  label: string,
  text: string
): Promise<StoredProjectFile> {
  const safeLabel =
    label
      .trim()
      .replace(/[^a-zA-Z0-9._ -]+/g, "_")
      .slice(0, 100) || "source"
  const contents = `Legacy derived text\nSource: ${safeLabel}\n\n${text}`
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16)
  return storeProjectFile(
    projectId,
    `Sources/Legacy derived - ${safeLabel}-${hash}.txt`,
    contents
  )
}
