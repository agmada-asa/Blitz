/** Verifies review gating, bounded cache writes, and clearly labelled legacy exports. */
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  approveDerivedSource,
  cacheDerivedText,
  exportLegacyText,
  listApprovedDerivedSources,
  listDerivedSources,
  MAX_DERIVED_TEXT_BYTES,
} from "../lib/server/derived-sources.ts"
import { getProjectDirectory } from "../lib/server/project-files.ts"

/** Runs a test with an isolated data root and removes it afterward. */
async function withDataRoot(run: () => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "blitz-derived-")
  )
  const previous = process.env.BLITZ_DATA_DIR
  process.env.BLITZ_DATA_DIR = root
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("derived text remains pending until explicit approval", async () => {
  await withDataRoot(async () => {
    const pending = await cacheDerivedText(
      "project",
      "upload.pdf",
      "agent extraction"
    )
    assert.equal(pending.status, "pending")
    assert.deepEqual(await listApprovedDerivedSources("project"), [])
    const approved = await approveDerivedSource("project", pending.id)
    assert.equal(approved.status, "approved")
    assert.equal(
      (await listApprovedDerivedSources("project"))[0]?.id,
      pending.id
    )
  })
})

test("retries are idempotent and oversized derived text is rejected", async () => {
  await withDataRoot(async () => {
    const first = await cacheDerivedText("project", "upload.pdf", "same result")
    const second = await cacheDerivedText(
      "project",
      "upload.pdf",
      "same result"
    )
    assert.deepEqual(second, first)
    assert.equal((await listDerivedSources("project")).length, 1)
    await assert.rejects(
      cacheDerivedText(
        "project",
        "large.pdf",
        "x".repeat(MAX_DERIVED_TEXT_BYTES + 1)
      ),
      /size limit/
    )
  })
})

test("legacy exports are clearly labelled under Sources", async () => {
  await withDataRoot(async () => {
    const result = await exportLegacyText("project", "Old notes", "legacy body")
    const second = await exportLegacyText(
      "project",
      "Old notes",
      "Different legacy text"
    )
    assert.notEqual(second.key, result.key)
    assert.match(
      result.key,
      /^Sources\/Legacy derived - Old notes-[a-f0-9]{16}\.txt$/
    )
    assert.match(
      await fs.readFile(result.path, "utf8"),
      /^Legacy derived text\nSource: Old notes\n\nlegacy body$/
    )
    assert.equal(
      await fs.readFile(
        join(getProjectDirectory("project"), result.key),
        "utf8"
      ),
      await fs.readFile(result.path, "utf8")
    )
  })
})
