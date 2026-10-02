/** Verifies discovery of the Codex dependency bundle and its instruction block. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  codexRuntimeInstructions,
  findCodexRuntime,
} from "../lib/server/providers/codex-runtime.ts"

/** Creates a minimal bundle layout, optionally omitting the Python runtime. */
async function fakeRuntime(options: { python: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blitz-codex-runtime-"))
  const dependencies = join(root, "dependencies")
  await writeFile(
    join(root, "runtime.json"),
    JSON.stringify({ bundleVersion: "1.2.3", pythonVersion: "3.12.14" })
  )
  await mkdir(join(dependencies, "node", "bin"), { recursive: true })
  await mkdir(join(dependencies, "node", "node_modules"), { recursive: true })
  await writeFile(join(dependencies, "node", "bin", "node"), "")
  await mkdir(join(dependencies, "python", "lib", "python3.12", "site-packages"), {
    recursive: true,
  })
  await mkdir(join(dependencies, "python", "bin"), { recursive: true })
  if (options.python)
    await writeFile(join(dependencies, "python", "bin", "python3"), "")
  return root
}

test("findCodexRuntime resolves a complete bundle into instruction paths", async () => {
  const root = await fakeRuntime({ python: true })
  try {
    const paths = await findCodexRuntime(root)
    assert.ok(paths)
    assert.equal(paths.bundleVersion, "1.2.3")
    assert.equal(
      paths.pythonLibrariesPath,
      join(root, "dependencies", "python", "lib", "python3.12", "site-packages")
    )
    const instructions = codexRuntimeInstructions(paths)
    assert.match(instructions, /^### Workspace Dependencies/)
    assert.ok(instructions.includes(`- Python executable: ${paths.pythonPath}`))
    assert.ok(instructions.includes(`- Override binaries: ${paths.overrideBinPath}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("findCodexRuntime ignores an incomplete or missing bundle", async () => {
  const root = await fakeRuntime({ python: false })
  try {
    assert.equal(await findCodexRuntime(root), null)
    assert.equal(await findCodexRuntime(join(root, "missing")), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
