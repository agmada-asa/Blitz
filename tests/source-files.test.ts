/** Verifies bounded original source storage, hashing, deduplication, and cleanup. */

import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  MAX_ORIGINAL_SOURCE_BYTES,
  storeOriginalSource,
} from "../lib/server/source-files.ts"
import {
  getProjectDirectory,
  resolveProjectFile,
} from "../lib/server/project-files.ts"

/** Creates a web stream from one deterministic byte payload. */
function streamFor(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

test("stores original bytes atomically and deduplicates retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-source-files-"))
  const previous = process.env.BLITZ_DATA_DIR
  process.env.BLITZ_DATA_DIR = root
  try {
    const bytes = new TextEncoder().encode("original source")
    const first = await storeOriginalSource({
      projectId: "project-a",
      filename: "lecture.txt",
      mimeType: "text/plain",
      body: streamFor(bytes),
    })
    const second = await storeOriginalSource({
      projectId: "project-a",
      filename: "renamed.txt",
      mimeType: "text/plain",
      body: streamFor(bytes),
    })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal(second.key, first.key)
    assert.deepEqual(
      await readFile(await resolveProjectFile("project-a", first.key)),
      Buffer.from(bytes)
    )
    const files = await readdir(join(root, "Projects"))
    assert.equal(files.length, 1)
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects an oversized stream without leaving a temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-source-files-"))
  const previous = process.env.BLITZ_DATA_DIR
  process.env.BLITZ_DATA_DIR = root
  try {
    await assert.rejects(
      storeOriginalSource({
        projectId: "project-b",
        filename: "huge.bin",
        body: streamFor(new Uint8Array(MAX_ORIGINAL_SOURCE_BYTES + 1)),
      }),
      /size limit/
    )
    const sourceDir = join(getProjectDirectory("project-b"), "Sources")
    assert.deepEqual(await readdir(sourceDir), [])
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
