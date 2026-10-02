/** Verifies arbitrary attachment handling, workspace file staging, and prompt path context. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { Id } from "../convex/_generated/dataModel.js"
import {
  prepareProjectAgentWorkspace,
  projectAgentInstructions,
  scanProjectArtifacts,
} from "../lib/server/project-agent.ts"
import {
  buildWorkspaceChatPrompt,
  mergeWorkspaceChatReplay,
  parseWorkspaceChatRequest,
  type WorkspaceChatInlineAttachment,
} from "../lib/server/workspace-chat.ts"

test("buildWorkspaceChatPrompt renders workspacePath and filePath for attachments", () => {
  const request = parseWorkspaceChatRequest({
    message: "Can you analyze this dataset and run the script?",
    projectId: "project-1",
    clientMessageId: "msg-1",
    projectIds: ["project-1"],
    attachments: [
      {
        kind: "file",
        label: "analysis.py",
        text: "print('analyzing')",
      },
      {
        kind: "file",
        label: "data.csv",
        text: "id,val\n1,100",
      },
      {
        kind: "file",
        label: "model.bin",
        text: "[Attached file: model.bin (1.5 MB)]",
      },
    ],
  })

  // Populate paths as chat route does when staging to workspace
  request.attachments[0].workspacePath = "attachments/analysis.py"
  request.attachments[0].filePath = "/mock/workspace/attachments/analysis.py"
  request.attachments[1].workspacePath = "attachments/data.csv"
  request.attachments[1].filePath = "/mock/workspace/attachments/data.csv"
  request.attachments[2].workspacePath = "attachments/model.bin"
  request.attachments[2].filePath = "/mock/workspace/attachments/model.bin"

  const prompt = buildWorkspaceChatPrompt(
    request,
    [
      {
        id: "project-1" as Id<"projects">,
        title: "Test Project",
        sources: [],
      },
    ]
  )

  // Verify attachment headers
  assert.match(prompt, /FILE: analysis\.py/)
  assert.match(prompt, /Workspace path: attachments\/analysis\.py/)
  assert.match(prompt, /File path: \/mock\/workspace\/attachments\/analysis\.py/)
  assert.match(prompt, /print\('analyzing'\)/)

  assert.match(prompt, /FILE: data\.csv/)
  assert.match(prompt, /Workspace path: attachments\/data\.csv/)
  assert.match(prompt, /File path: \/mock\/workspace\/attachments\/data\.csv/)
  assert.match(prompt, /id,val/)

  assert.match(prompt, /FILE: model\.bin/)
  assert.match(prompt, /Workspace path: attachments\/model\.bin/)
  assert.match(prompt, /File path: \/mock\/workspace\/attachments\/model\.bin/)
  assert.match(prompt, /\[Attached file: model\.bin \(1\.5 MB\)\]/)
})

test("buildWorkspaceChatPrompt formats attachments cleanly when paths are omitted", () => {
  const request = parseWorkspaceChatRequest({
    message: "Explain this note",
    clientMessageId: "msg-2",
    projectIds: [],
    attachments: [
      {
        kind: "file",
        label: "notes.txt",
        text: "simple text without path",
      },
    ],
  })

  const prompt = buildWorkspaceChatPrompt(request, [])
  assert.match(prompt, /FILE: notes\.txt/)
  assert.match(prompt, /simple text without path/)
  assert.doesNotMatch(prompt, /Workspace path:/)
  assert.doesNotMatch(prompt, /File path:/)
})

test("mergeWorkspaceChatReplay preserves attachment paths during session recovery", () => {
  const request = parseWorkspaceChatRequest({
    message: "Follow up question",
    clientMessageId: "msg-replay",
    projectIds: [],
    attachments: [],
  })

  const replayedAttachment: WorkspaceChatInlineAttachment = {
    kind: "file",
    label: "script.sh",
    text: "#!/bin/bash\necho test",
    workspacePath: "attachments/script.sh",
    filePath: "/workspace/attachments/script.sh",
  }

  const merged = mergeWorkspaceChatReplay(request, {
    messages: [],
    projectIds: [],
    attachments: [replayedAttachment],
  })

  assert.equal(merged.request.attachments.length, 1)
  assert.equal(
    merged.request.attachments[0]?.workspacePath,
    "attachments/script.sh"
  )
  assert.equal(
    merged.request.attachments[0]?.filePath,
    "/workspace/attachments/script.sh"
  )
})

test("projectAgentInstructions informs agent that user attachments are in working directory", () => {
  const instructions = projectAgentInstructions("/tmp/mock-workspace")
  assert.match(instructions, /attachments\//)
  assert.match(instructions, /ATTACHED CONTEXT/)
  assert.match(
    instructions,
    /Attached files from the user are available in your working directory under attachments\//
  )
})

test("scanProjectArtifacts excludes attachments directory from agent output artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blitz-attachments-test-"))
  const previous = process.env.BLITZ_DATA_DIR
  t.after(async () => {
    if (previous === undefined) delete process.env.BLITZ_DATA_DIR
    else process.env.BLITZ_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  process.env.BLITZ_DATA_DIR = root

  const workspace = await prepareProjectAgentWorkspace(
    "project-artifacts-test",
    "Artifacts"
  )
  // Simulate user attachment copied into working directory
  await mkdir(join(workspace.projectDirectory, "attachments"), {
    recursive: true,
  })
  await writeFile(
    join(workspace.projectDirectory, "attachments", "user-input.csv"),
    "col1,col2"
  )

  // Simulate agent-generated output artifact
  await writeFile(
    join(workspace.projectDirectory, "output-summary.md"),
    "# Summary"
  )

  const artifacts = await scanProjectArtifacts(workspace.projectDirectory)
  const relativeKeys = artifacts.map((a) => a.relativeKey)

  assert.ok(
    relativeKeys.includes("output-summary.md"),
    "Agent output artifact should be included"
  )
  assert.ok(
    !relativeKeys.some((k) => k.startsWith("attachments")),
    "attachments folder must be excluded from agent artifacts"
  )
})

test("buildWorkspaceChatPrompt points the agent at full text when only a preview is inline", () => {
  const request = parseWorkspaceChatRequest({
    message: "Teach me section 3.3",
    clientMessageId: "msg-long-pdf",
    projectIds: [],
    attachments: [
      {
        kind: "file",
        label: "textbook.pdf",
        text: "[Page 1]\nContents\n[Preview ends here. The full page-marked text is in a separate attached file.]",
      },
    ],
  })
  request.attachments[0].workspacePath = "attachments/doc-textbook.pdf"
  request.attachments[0].textWorkspacePath =
    "attachments/doc-textbook.pdf.pages.txt"

  const prompt = buildWorkspaceChatPrompt(request, [])

  assert.match(
    prompt,
    /Full extracted text: attachments\/doc-textbook\.pdf\.pages\.txt \(pages begin with \[Page N\] markers/
  )
})
