/** Verifies project directory isolation and the local file security boundary. */
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  getProjectDirectory,
  normalizeProjectFileKey,
  resolveProjectFile,
  readProjectFileBytes,
  storeProjectFile,
  streamProjectFile,
} from "../lib/server/project-files.ts"

/** Runs a test with an isolated data root and removes it afterward. */
async function withDataRoot(
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), "blitz-project-files-"))
  const previous = process.env.BLITZ_DATA_DIR
  process.env.BLITZ_DATA_DIR = root
  try {
    await run(root)
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("same-named projects have stable isolated directories", async () => {
  await withDataRoot(async (root) => {
    const first = getProjectDirectory("project-a", "Same name")
    const second = getProjectDirectory("project-b", "Same name")
    assert.notEqual(first, second)
    await storeProjectFile(
      "project-a",
      "Sources/notes.txt",
      "first",
      "Same name"
    )
    await storeProjectFile(
      "project-b",
      "Sources/notes.txt",
      "second",
      "Same name"
    )
    assert.equal(
      await fs.readFile(join(first, "Sources/notes.txt"), "utf8"),
      "first"
    )
    assert.equal(
      await fs.readFile(join(second, "Sources/notes.txt"), "utf8"),
      "second"
    )
    assert.ok(first.startsWith(root))
  })
})

test("file keys reject absolute paths, traversal, null bytes, and reserved directories", () => {
  for (const key of [
    "/tmp/escape",
    "../escape",
    "nested/../../escape",
    "nested\\..\\escape",
    ".blitz/state.json",
    "nested/.blitz/state.json",
    "bad\0key",
    "C:\\escape.txt",
    "c:/escape.txt",
    ".BLITZ/state.json",
  ])
    assert.throws(() => normalizeProjectFileKey(key))
  assert.equal(
    normalizeProjectFileKey("Sources\\notes.txt"),
    "Sources/notes.txt"
  )
})

test("symlinked data roots and Projects directories are rejected before creation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "blitz-project-files-"))
  const outside = await fs.mkdtemp(join(tmpdir(), "blitz-outside-"))
  const previous = process.env.BLITZ_DATA_DIR
  try {
    await fs.symlink(outside, join(root, "Projects"), "dir")
    process.env.BLITZ_DATA_DIR = root
    await assert.rejects(
      storeProjectFile("linked-projects", "file.txt", "blocked"),
      /symlink/
    )
    assert.deepEqual(await fs.readdir(outside), [])

    const linkedRoot = join(root, "linked-root")
    await fs.symlink(outside, linkedRoot, "dir")
    process.env.BLITZ_DATA_DIR = linkedRoot
    await assert.rejects(
      storeProjectFile("linked-root", "file.txt", "blocked"),
      /symlink/
    )
    assert.deepEqual(await fs.readdir(outside), [])
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("missing data roots cannot hide behind a symlink ancestor", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "blitz-project-files-"))
  const outside = await fs.mkdtemp(join(tmpdir(), "blitz-outside-"))
  const previous = process.env.BLITZ_DATA_DIR
  try {
    const linkedAncestor = join(root, "linked-ancestor")
    await fs.symlink(outside, linkedAncestor, "dir")
    process.env.BLITZ_DATA_DIR = join(linkedAncestor, "missing-root")
    await assert.rejects(
      storeProjectFile("nested-link", "file.txt", "blocked"),
      /symlink/
    )
    assert.deepEqual(await fs.readdir(outside), [])
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("symlinked project paths cannot be read or written", async () => {
  await withDataRoot(async () => {
    const projectRoot = getProjectDirectory("symlinked")
    await fs.mkdir(projectRoot, { recursive: true })
    const outside = await fs.mkdtemp(join(tmpdir(), "blitz-outside-"))
    try {
      await fs.symlink(outside, join(projectRoot, "escape"), "dir")
      await assert.rejects(
        resolveProjectFile("symlinked", "escape/file.txt"),
        /symlink/
      )
      await assert.rejects(
        storeProjectFile("symlinked", "escape/file.txt", "secret"),
        /symlink/
      )
      await assert.rejects(fs.access(join(outside, "file.txt")))
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

test("uploads hash and rename atomically without leaving partial files", async () => {
  await withDataRoot(async () => {
    const input = (async function* () {
      yield new TextEncoder().encode("hello ")
      yield new TextEncoder().encode("world")
    })()
    const result = await storeProjectFile("upload", "Sources/data.txt", input)
    assert.equal(result.size, 11)
    assert.equal(
      result.sha256,
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    )
    assert.equal(await fs.readFile(result.path, "utf8"), "hello world")
    assert.deepEqual(
      (await fs.readdir(join(getProjectDirectory("upload"), "Sources"))).sort(),
      ["data.txt"]
    )
  })
})

test("interrupted uploads remove their temporary file", async () => {
  await withDataRoot(async () => {
    const input = (async function* () {
      yield new TextEncoder().encode("partial")
      throw new Error("stream interrupted")
    })()
    await assert.rejects(
      storeProjectFile("interrupted", "Sources/data.txt", input),
      /interrupted/
    )
    const sourceDirectory = join(getProjectDirectory("interrupted"), "Sources")
    assert.deepEqual(await fs.readdir(sourceDirectory), [])
  })
})

test("downloads enforce byte limits and reject symlink targets", async () => {
  await withDataRoot(async () => {
    await storeProjectFile("download", "Sources/file.txt", "original")
    assert.equal(
      (
        await readProjectFileBytes("download", "Sources/file.txt", 20)
      ).toString(),
      "original"
    )
    await assert.rejects(
      readProjectFileBytes("download", "Sources/file.txt", 2),
      /size limit/
    )
    await fs.symlink(
      "Sources/file.txt",
      join(getProjectDirectory("download"), "alias.txt")
    )
    await assert.rejects(
      readProjectFileBytes("download", "alias.txt", 20),
      /symlink/
    )
    await assert.rejects(streamProjectFile("download", "alias.txt"), /symlink/)
  })
})
