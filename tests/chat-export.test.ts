/** Verifies the Markdown transcript and filename the Export chat dialog produces. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { chatExportFilename, chatMarkdown } from "../lib/client/chat-export.ts"

/** A short chat whose reply used a tool and asked for approval. */
const messages = [
  { role: "user", content: "What is a cache?" },
  {
    role: "assistant",
    content: "A small fast store.",
    thought: "  Check the notes first.  ",
    providerEvents: [
      { id: "a1", type: "tool", title: "Search", status: "completed", detail: " notes " },
    ],
    agentRequests: [
      {
        id: "r1",
        method: "exec",
        details: "Run ls",
        expiresAt: 1,
        status: "approved",
      },
      { not: "a request" },
    ],
  },
  { role: "assistant", content: "" },
]

test("exports messages only, or with the agent's working", () => {
  assert.equal(
    chatMarkdown(" Caches ", messages, false),
    "# Caches\n\n---\n\n## You\n\nWhat is a cache?\n\n---\n\n## Blitz\n\nA small fast store.\n\n---\n\n## Blitz\n\n_(No message text)_\n"
  )
  const full = chatMarkdown(undefined, messages, true)
  assert.match(full, /^# Chat\n/)
  assert.match(full, /### Agent working\n\nCheck the notes first\.\n/)
  assert.match(full, /### Tool: Search \(completed\)\n\nnotes\n/)
  assert.match(full, /### Agent request: Review needed \(approved\)\n\nRun ls\n/)
  assert.equal(full.match(/### Agent request/g)?.length, 1)
})

test("names the file after the chat", () => {
  assert.equal(chatExportFilename("Week 3: caches & TLBs"), "Week-3-caches-TLBs.md")
  assert.equal(chatExportFilename("***"), "chat.md")
  assert.equal(chatExportFilename(undefined), "chat.md")
})
