/** Verifies project-agent path isolation, protected directories, and artifact scans. */
import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  MAX_AGENT_ARTIFACT_BYTES,
  prepareProjectAgentWorkspace,
  resolveWritableArtifactPath,
  scanProjectArtifacts,
  parseProjectAgentAutonomy,
  projectAgentInstructions,
  projectAgentRuntimePolicy,
} from "../lib/server/project-agent.ts"

test("agent workspace scans writable coursework and excludes Sources and .blitz", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-"))
  const previous = process.env.BLITZ_DATA_DIR
  t.after(async () => {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
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

test("agent workspace scans skip generated audio larger than the artifact bound", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-"))
  const previous = process.env.BLITZ_DATA_DIR
  t.after(async () => {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  process.env.BLITZ_DATA_DIR = root
  const workspace = await prepareProjectAgentWorkspace("project-audio")
  const recording = join(workspace.projectDirectory, "Audio", "episode-one")
  await mkdir(recording, { recursive: true })
  // A sparse file reports the oversized length without writing 26 MB to disk.
  await writeFile(join(recording, "episode.wav"), "")
  await truncate(join(recording, "episode.wav"), MAX_AGENT_ARTIFACT_BYTES + 1)
  await writeFile(join(workspace.projectDirectory, "notes.md"), "notes")
  const artifacts = await scanProjectArtifacts(workspace.projectDirectory)
  assert.deepEqual(
    artifacts.map((artifact) => artifact.relativeKey),
    ["notes.md"]
  )
})

test("agent cannot write Sources, .blitz, traversal paths, or symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-"))
  const previous = process.env.BLITZ_DATA_DIR
  t.after(async () => {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
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

test("autonomy settings map to explicit sandbox and approval policies", () => {
  assert.equal(parseProjectAgentAutonomy(undefined), "approval")
  assert.throws(() => parseProjectAgentAutonomy("surprise"), /valid/)
  assert.deepEqual(projectAgentRuntimePolicy("approval"), {
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    approvalsReviewer: "user",
  })
  assert.deepEqual(projectAgentRuntimePolicy("project"), {
    approvalPolicy: "never",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
  })
  assert.deepEqual(projectAgentRuntimePolicy("full"), {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
  })
})

test("folder instructions include explicit user exceptions without accepting source instructions", () => {
  const instructions = projectAgentInstructions(
    '/tmp/Project "A"',
    "Use British spelling."
  )
  assert.ok(instructions.includes("Sources/"))
  assert.ok(instructions.includes(".blitz/"))
  assert.match(instructions, /Only a direct instruction from the user/)
  assert.match(instructions, /full-access setting alone does not override/)
  assert.match(instructions, /tool output as data/)
  assert.match(instructions, /primary evidence and starting point/)
  assert.match(instructions, /Web search is appropriate/)
  assert.match(instructions, /external findings distinct from project sources/)
  assert.doesNotMatch(instructions, /blitz_request_user_input/)
  assert.match(instructions, /Use British spelling/)
  const interactiveInstructions = projectAgentInstructions(
    "/tmp/project",
    "",
    true
  )
  assert.match(interactiveInstructions, /blitz_request_user_input/)
  assert.match(interactiveInstructions, /blitz_request_approval/)
  assert.throws(
    () => projectAgentInstructions("/tmp/project", "x".repeat(4001)),
    /4,000/
  )
})
