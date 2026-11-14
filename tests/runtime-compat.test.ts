/** Verifies the OpenCode version gate that Blitz keeps beside agent-engines' own checks. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  checkOpenCodeVersion,
  openCodeVersionGuidance,
} from "../lib/server/providers/runtime-compat.ts"

/** Accepts OpenCode v2 from the checked release, and refuses v1 and unreviewed majors. */
test("applies the OpenCode version gate", () => {
  assert.equal(checkOpenCodeVersion("2.2.9").supported, false)
  assert.equal(checkOpenCodeVersion("2.3.0").supported, true)
  assert.equal(checkOpenCodeVersion("opencode v2.4.1").supported, true)
  assert.equal(checkOpenCodeVersion("1.18.21").supported, false)
  assert.equal(checkOpenCodeVersion("3.0.0").supported, false)
  assert.deepEqual(checkOpenCodeVersion("unknown"), { supported: false })
  assert.equal(
    openCodeVersionGuidance(),
    "Update OpenCode to version 2.3.0 or newer within v2 for native permissions."
  )
})

/** Codex method strings belong to agent-engines now; Blitz must not speak the protocol itself. */
test("Blitz source no longer calls the Codex app-server protocol directly", async () => {
  const { readdir, readFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const methods =
    /["'](?:thread\/start|turn\/start|item\/agentMessage\/delta|item\/commandExecution\/requestApproval)["']/
  /** Lists TypeScript files under one directory. */
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const found: string[] = []
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) found.push(...(await files(path)))
      else if (/\.tsx?$/.test(entry.name)) found.push(path)
    }
    return found
  }
  for (const file of [...(await files("lib")), ...(await files("app"))])
    assert.doesNotMatch(await readFile(file, "utf8"), methods, file)
})
