/** Reads agent-written lesson drafts from a bounded project-local staging folder. */

import { constants, promises as fs } from "node:fs"
import { join } from "node:path"
import {
  contentManifestSchema,
  validateLessonDraft,
  type ContentManifest,
  type LessonDraft,
} from "../content-generation.ts"

/** Maximum bytes accepted from one agent-authored draft file. */
const MAX_MANIFEST_BYTES = 200_000
const MAX_PAGE_BYTES = 32_000

/** Reads a regular file without following a symbolic link or unbounded output. */
async function readBoundedJson(path: string, limit: number): Promise<unknown> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Generated content file exceeds its size limit")
    return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown
  } finally {
    await file.close()
  }
}

/** Validates every page before the worker publishes any of them to Convex. */
export async function readContentDrafts(
  draftDirectory: string,
  sourceId: string,
  depth: number,
  knownSourceIds: ReadonlySet<string>,
  expectedSectionIds: ReadonlySet<string> = new Set()
): Promise<{ manifest: ContentManifest; pages: LessonDraft[] }> {
  for (const directory of [draftDirectory, join(draftDirectory, "pages")]) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Generated content directory is invalid")
  }
  const manifest = contentManifestSchema.parse(
    await readBoundedJson(
      join(draftDirectory, "manifest.json"),
      MAX_MANIFEST_BYTES
    )
  )
  if (manifest.sourceId !== sourceId)
    throw new Error("Content manifest belongs to another source")
  if (!manifest.pages.length && !manifest.skippedReason)
    throw new Error("Empty content manifest needs a reason")
  if (new Set(manifest.pages).size !== manifest.pages.length)
    throw new Error("Content manifest repeats a page file")
  const coveredIds = new Set(manifest.coverage.map((entry) => entry.sectionId))
  if (coveredIds.size !== manifest.coverage.length)
    throw new Error("Content manifest repeats a source section")
  if (
    expectedSectionIds.size &&
    (coveredIds.size !== expectedSectionIds.size ||
      [...expectedSectionIds].some((id) => !coveredIds.has(id)))
  )
    throw new Error("Content manifest omits source sections")
  const pageKeys = new Set(manifest.pages.map((path) => path.slice(6, -5)))
  for (const entry of manifest.coverage) {
    if (entry.status === "included" && !entry.pageKeys.length)
      throw new Error("Included source section needs a lesson page")
    if (entry.status === "skipped" && (!entry.reason || entry.pageKeys.length))
      throw new Error("Skipped source section needs a reason and no page")
    if (entry.pageKeys.some((key) => !pageKeys.has(key)))
      throw new Error("Source coverage references an unknown page")
  }
  if (
    [...pageKeys].some(
      (key) => !manifest.coverage.some((entry) => entry.pageKeys.includes(key))
    )
  )
    throw new Error("A lesson page has no covered source section")
  const pages: LessonDraft[] = []
  const concepts = new Set<string>()
  for (const relativePath of manifest.pages) {
    const page = validateLessonDraft(
      await readBoundedJson(join(draftDirectory, relativePath), MAX_PAGE_BYTES),
      depth,
      knownSourceIds,
      sourceId
    )
    if (relativePath !== `pages/${page.key}.json`)
      throw new Error("Lesson filename does not match its page key")
    if (!page.conceptId && !page.questions.length)
      throw new Error("New concepts need at least one check question")
    const conceptKey =
      page.conceptId ??
      `${page.topicTitle.toLocaleLowerCase()}\0${page.conceptTitle.toLocaleLowerCase()}`
    if (concepts.has(conceptKey))
      throw new Error("Content draft repeats a concept")
    concepts.add(conceptKey)
    pages.push(page)
  }
  return { manifest, pages }
}
