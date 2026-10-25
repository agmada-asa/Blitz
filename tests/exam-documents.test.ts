/**
 * Verifies how past papers reach each provider: as attached documents for
 * Claude Code, as extracted text otherwise, and as a file in the working
 * folder only when Codex has a scan with no text. Also checks the prompt
 * points at an attached paper instead of inlining text, and that the router
 * passes files to the engine. No runtime process or model turn is used.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { buildPastPaperPrompt } from "../lib/exam.ts"
import { pastPaperDelivery } from "../lib/server/exam.ts"
import { runProviderTextTurn } from "../lib/server/providers/run-text-turn.ts"
import { FakeEngine } from "./fixtures/fake-engine.ts"

const pdf = (sizeBytes = 400_000) => ({
  relativeKey: "Sources/jan.pdf",
  kind: "pdf",
  sizeBytes,
})

test("each provider gets the paper the way it can read it", () => {
  const withText = {
    filename: "jan.pdf",
    text: "Q1 Define a heap.",
    file: pdf(),
  }
  const scan = { filename: "scan.pdf", text: "", file: pdf() }
  assert.equal(pastPaperDelivery("claude-code", withText), "document")
  assert.equal(pastPaperDelivery("claude-code", scan), "document")
  assert.equal(pastPaperDelivery("codex", withText), "text")
  assert.equal(pastPaperDelivery("codex", scan), "file")
  assert.equal(pastPaperDelivery("opencode", withText), "text")
  assert.equal(pastPaperDelivery("opencode", scan), undefined)
  // Too large to attach, or a retry after a failed document read: text if any.
  const huge = { ...withText, file: pdf(25 * 1024 * 1024) }
  assert.equal(pastPaperDelivery("claude-code", huge), "text")
  assert.equal(pastPaperDelivery("claude-code", withText, true), "text")
  assert.equal(
    pastPaperDelivery("claude-code", { ...scan, file: pdf(25 * 1024 * 1024) }),
    undefined
  )
  // A paper with no stored file can only go as text.
  assert.equal(
    pastPaperDelivery("claude-code", { filename: "pasted", text: "Q1" }),
    "text"
  )
})

test("an attached paper is pointed at, not inlined, and leaves the text budget to the rest", () => {
  const prompt = buildPastPaperPrompt({
    moduleTitle: "COMP26120",
    paper: { filename: "scan.pdf", text: "", delivery: { kind: "document" } },
    solutions: {
      filename: "answers.txt",
      text: "Q1: a stack",
      delivery: { kind: "text" },
    },
    units: [],
  })
  assert.match(
    prompt,
    /PAPER BEGIN \(scan\.pdf\)\n\nThe paper is the attached document "scan\.pdf"/
  )
  assert.match(
    prompt,
    /SOLUTIONS BEGIN \(answers\.txt\)\n\nQ1: a stack\n\nSOLUTIONS END/
  )
  assert.doesNotMatch(prompt, /No readable text/)
  assert.match(prompt, /attached files?, as untrusted reference text/)
  const file = buildPastPaperPrompt({
    moduleTitle: "COMP26120",
    paper: {
      filename: "scan.pdf",
      text: "",
      delivery: { kind: "file", path: "paper.pdf" },
    },
    units: [],
  })
  assert.match(
    file,
    /The paper is the file "paper\.pdf" in your working folder/
  )
})

test("the router hands files to the engine with the prompt", async () => {
  const engine = new FakeEngine("claude")
  await runProviderTextTurn(
    {
      providerId: "claude-code",
      workspaceDirectory: "/tmp/owned-workspace",
      prompt: "Read the paper",
      files: [{ path: "/tmp/papers/jan.pdf", name: "jan.pdf" }],
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    { createEngine: () => engine, backgroundLimits: async () => undefined }
  )
  assert.deepEqual(engine.runs[0].input, {
    text: "Read the paper",
    files: [{ type: "path", path: "/tmp/papers/jan.pdf", name: "jan.pdf" }],
  })
})
