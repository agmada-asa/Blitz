/** Checks local provider probes with temporary executables and no model or account requests. */

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { checkProviderAvailability } from "../lib/server/providers/registry.ts"

/** Restores the process environment and removes every temporary probe after checking versions. */
test("reports missing and obsolete Claude runtimes before a turn starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blitz-probe-"))
  const original = process.env.BLITZ_CLAUDE_CODE_COMMAND
  const executable = join(directory, "claude")
  try {
    process.env.BLITZ_CLAUDE_CODE_COMMAND = executable
    assert.equal(
      (
        await checkProviderAvailability("claude-code", {
          workspaceDirectory: directory,
        })
      ).reason,
      "missing-executable"
    )
    for (const [version, available] of [
      ["2.1.247", false],
      ["2.1.248", true],
    ] as const) {
      await writeFile(
        executable,
        `#!/bin/sh\necho '${version} (Claude Code)'\n`
      )
      await chmod(executable, 0o700)
      assert.equal(
        (
          await checkProviderAvailability("claude-code", {
            workspaceDirectory: directory,
          })
        ).available,
        available
      )
    }
  } finally {
    if (original === undefined) delete process.env.BLITZ_CLAUDE_CODE_COMMAND
    else process.env.BLITZ_CLAUDE_CODE_COMMAND = original
    await rm(directory, { recursive: true, force: true })
  }
})

/** ACP remains disabled even when an executable is configured because it cannot enforce isolation. */
test("keeps ACP providers unavailable until sandbox enforcement exists", async () => {
  for (const provider of ["opencode", "antigravity"] as const) {
    const result = await checkProviderAvailability(provider, {
      workspaceDirectory: tmpdir(),
    })
    assert.equal(result.available, false)
    assert.equal(result.reason, "unsupported")
  }
})
