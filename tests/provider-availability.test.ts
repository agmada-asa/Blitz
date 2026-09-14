/** Checks local provider probes with temporary executables and no model or account requests. */

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import {
  checkProviderAvailability,
  parseOpenCodeAccounts,
} from "../lib/server/providers/registry.ts"

/** Extracts only account labels from OpenCode's ANSI-formatted credential list. */
test("parses configured OpenCode accounts without credential data", () => {
  assert.deepEqual(
    parseOpenCodeAccounts(
      "\u001b[0m●  Google \u001b[90mapi\u001b[0m\n●  OpenAI \u001b[90moauth\u001b[0m\n"
    ),
    ["Google", "OpenAI"]
  )
})

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

/** Native ACP availability depends on installation instead of a blanket provider ban. */
test("reports missing ACP executables with actionable setup guidance", async () => {
  for (const [provider, key] of [
    ["opencode", "BLITZ_OPENCODE_COMMAND"],
    ["antigravity", "BLITZ_ANTIGRAVITY_ACP_COMMAND"],
  ] as const) {
    const original = process.env[key]
    try {
      process.env[key] = "/nonexistent/blitz/provider"
      const result = await checkProviderAvailability(provider, {
        workspaceDirectory: tmpdir(),
      })
      assert.equal(result.available, false)
      assert.equal(result.reason, "missing-executable")
    } finally {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  }
})
