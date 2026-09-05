/** Verifies workspace chat request bounds and the prompt's trust boundary. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildWorkspaceChatPrompt,
  parseWorkspaceChatRequest,
} from "../lib/server/workspace-chat.ts"
import type { Id } from "../convex/_generated/dataModel.d.ts"

test("parseWorkspaceChatRequest accepts mixed attachment context", () => {
  const result = parseWorkspaceChatRequest({
    message: "Compare these notes",
    threadId: "thread-1",
    projectIds: ["project-1"],
    attachments: [
      {
        kind: "link",
        label: "Lecture notes",
        text: "A useful claim",
        url: "https://example.com/notes",
      },
    ],
  })

  assert.equal(result.message, "Compare these notes")
  assert.equal(result.projectIds.length, 1)
  assert.equal(result.attachments[0]?.kind, "link")
})

test("parseWorkspaceChatRequest rejects unsafe attachment URLs", () => {
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Read this",
        projectIds: [],
        attachments: [
          {
            kind: "link",
            label: "Local file",
            text: "content",
            url: "file:///etc/passwd",
          },
        ],
      }),
    /Attachment URL is invalid/
  )
})

test("buildWorkspaceChatPrompt labels attached material as untrusted", () => {
  const request = parseWorkspaceChatRequest({
    message: "What connects these ideas?",
    projectIds: ["project-1"],
    attachments: [{ kind: "file", label: "outline.txt", text: "First idea" }],
  })
  const prompt = buildWorkspaceChatPrompt(request, [
    {
      id: "project-1" as Id<"projects">,
      title: "Biology",
      sources: [
        {
          filename: "cells.md",
          kind: "markdown",
          extractedText: "Second idea",
        },
      ],
    },
  ])

  assert.match(prompt, /untrusted reference material/)
  assert.match(prompt, /PROJECT: Biology/)
  assert.match(prompt, /SOURCE: cells.md/)
  assert.match(prompt, /FILE: outline.txt/)
  assert.match(prompt, /What connects these ideas\?/)
})
