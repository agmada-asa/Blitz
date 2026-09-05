/** Verifies project-agent path isolation, protected directories, and artifact scans. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  prepareProjectAgentWorkspace,
  resolveWritableArtifactPath,
  scanProjectArtifacts,
  runProjectAgent,
} from "../lib/server/project-agent.ts"

test("agent workspace scans writable coursework and excludes Sources and .blitz", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-"))
  process.env.BLITZ_DATA_DIR = root
  const workspace = await prepareProjectAgentWorkspace("project-one", "Course")
  await writeFile(join(workspace.projectDirectory, "essay.md"), "draft")
  await writeFile(
    join(workspace.projectDirectory, "Sources", "original.txt"),
    "original"
  )
  await writeFile(
    join(workspace.projectDirectory, ".blitz", "state.json"),
    "{}"
  )
  const artifacts = await scanProjectArtifacts(workspace.projectDirectory)
  assert.deepEqual(
    artifacts.map((artifact) => artifact.relativeKey),
    ["essay.md"]
  )
})

test("agent cannot write Sources, .blitz, traversal paths, or symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-"))
  process.env.BLITZ_DATA_DIR = root
  const workspace = await prepareProjectAgentWorkspace("project-two")
  assert.throws(
    () =>
      resolveWritableArtifactPath(workspace.projectDirectory, "Sources/x.txt"),
    /protected|reserved/
  )
  assert.throws(
    () => resolveWritableArtifactPath(workspace.projectDirectory, ".blitz/x"),
    /protected|reserved/
  )
  assert.throws(
    () => resolveWritableArtifactPath(workspace.projectDirectory, "../other"),
    /invalid|escapes/
  )
  await mkdir(join(root, "outside"))
  await symlink(join(root, "outside"), join(workspace.projectDirectory, "link"))
  await assert.rejects(
    () => scanProjectArtifacts(workspace.projectDirectory),
    /symlinks/
  )
})

test("agent execution fails closed when protected filesystem isolation is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-gate-"))
  process.env.BLITZ_DATA_DIR = root
  const workspace = await prepareProjectAgentWorkspace("blocked-agent")
  await assert.rejects(
    runProjectAgent(workspace, "Create a coursework file"),
    /File isolation support is required/
  )
})
