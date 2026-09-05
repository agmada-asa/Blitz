/** Verifies project-agent path isolation, protected directories, and artifact scans. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  prepareProjectAgentWorkspace,
  resolveWritableArtifactPath,
  scanProjectArtifacts,
  runProjectAgent,
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
  const approval = projectAgentRuntimePolicy("approval", "/tmp/project")
  assert.equal(approval.thread.approvalPolicy, "untrusted")
  assert.deepEqual(approval.turn, { type: "readOnly", networkAccess: false })
  const project = projectAgentRuntimePolicy("project", "/tmp/project")
  assert.equal(project.thread.approvalPolicy, "never")
  assert.deepEqual(project.turn, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/project"],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  })
  const full = projectAgentRuntimePolicy("full", "/tmp/project")
  assert.equal(full.thread.sandbox, "danger-full-access")
  assert.deepEqual(full.turn, { type: "dangerFullAccess" })
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
  assert.match(instructions, /Use British spelling/)
  assert.throws(
    () => projectAgentInstructions("/tmp/project", "x".repeat(4001)),
    /4,000/
  )
})

test("project tasks attach developer instructions and selected runtime policy before execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blitz-agent-run-"))
  const previous = process.env.BLITZ_DATA_DIR
  t.after(async () => {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  process.env.BLITZ_DATA_DIR = root
  const workspace = await prepareProjectAgentWorkspace("test-agent")
  let closed = false
  let listener:
    | ((
        event: import("../lib/server/codex-app-server.ts").CodexAppServerEvent
      ) => void)
    | undefined
  const result = await runProjectAgent(workspace, "Make a study guide", {
    autonomy: "project",
    additionalInstructions: "Use British spelling.",
    connect: async (options) => {
      assert.equal(options.workspaceDirectory, workspace.projectDirectory)
      assert.equal(options.webSearchMode, "disabled")
      return {
        startThread: async (options) => {
          assert.equal(options?.sandbox, "workspace-write")
          assert.equal(options?.approvalPolicy, "never")
          assert.match(options?.developerInstructions ?? "", /Sources/)
          assert.match(options?.developerInstructions ?? "", /British spelling/)
          return { thread: { id: "thread" } }
        },
        resumeThread: async () => {
          throw new Error("Unexpected resume")
        },
        startTurn: async (_id, options) => {
          assert.equal(options.text, "Make a study guide")
          assert.equal(options.sandboxPolicy?.type, "workspaceWrite")
          await writeFile(join(workspace.projectDirectory, "guide.md"), "Guide")
          listener?.({
            type: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread",
                turnId: "turn",
                delta: "Created guide.md",
              },
            },
          })
          listener?.({
            type: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread",
                turn: { id: "turn", status: "completed" },
              },
            },
          })
          return { turn: { id: "turn", status: "inProgress" } }
        },
        interruptTurn: async () => {},
        onEvent: (callback) => {
          listener = callback
          return () => {
            listener = undefined
          }
        },
        close: async () => {
          closed = true
        },
      }
    },
  })
  assert.equal(closed, true)
  assert.equal(result.response, "Created guide.md")
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.relativeKey),
    ["guide.md"]
  )
})
