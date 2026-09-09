/** Verifies workspace chat request bounds and the prompt's trust boundary. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildWorkspaceChatPrompt,
  combineWorkspaceChatContinuation,
  mergeWorkspaceChatReplay,
  parseWorkspaceChatRequest,
  type WorkspaceChatCardContext,
  WORKSPACE_CHAT_CONTINUATION_PROMPT,
} from "../lib/server/workspace-chat.ts"
import type { Id } from "../convex/_generated/dataModel.d.ts"

test("parseWorkspaceChatRequest accepts mixed attachment context", () => {
  const result = parseWorkspaceChatRequest({
    message: "Compare these notes",
    chatId: "chat-1",
    clientMessageId: "message-1",
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
        projectId: "project-1",
        clientMessageId: "message-2",
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

test("parseWorkspaceChatRequest keeps card chats on a fresh workspace session", () => {
  const result = parseWorkspaceChatRequest({
    message: "Why does this matter?",
    projectId: "project-1",
    clientMessageId: "message-card",
    card: { projectId: "project-1", itemId: "item-1" },
    projectIds: [],
    attachments: [],
  })

  assert.equal(result.card?.projectId, "project-1")
  assert.equal(result.card?.itemId, "item-1")
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Ask again",
        chatId: "existing-chat",
        clientMessageId: "message-card-2",
        card: { projectId: "project-1", itemId: "item-1" },
        projectIds: [],
        attachments: [],
      }),
    /Card chats must start a new chat/
  )
})

test("replays saved history and attachments when Codex context needs recovery", () => {
  const request = parseWorkspaceChatRequest({
    message: "Try again",
    chatId: "chat-1",
    clientMessageId: "message-retry",
    projectIds: [],
    attachments: [],
  })
  const replay = mergeWorkspaceChatReplay(request, {
    messages: [
      {
        role: "user",
        content: "Which synth should I learn for leads?",
        status: "completed",
      },
      {
        role: "assistant",
        content: "I will compare subtractive, FM, and wavetable synthesis.",
        status: "failed",
      },
    ],
    projectIds: ["project-1" as Id<"projects">],
    attachments: [
      { kind: "file", label: "notes.txt", text: "Oscillator notes" },
    ],
  })
  const prompt = buildWorkspaceChatPrompt(
    replay.request,
    [
      {
        id: "project-1" as Id<"projects">,
        title: "Sound design",
        sources: [],
      },
    ],
    undefined,
    replay.history
  )

  assert.match(prompt, /Which synth should I learn for leads\?/)
  assert.match(prompt, /status\":\"failed/)
  assert.match(prompt, /PROJECT: Sound design/)
  assert.match(prompt, /FILE: notes.txt/)
  assert.match(prompt, /USER MESSAGE BEGIN\nTry again/)
})

test("continuation requests use a server-owned prompt and cannot add context", () => {
  const result = parseWorkspaceChatRequest({
    chatId: "chat-1",
    continuationOf: "assistant-1",
    clientMessageId: "message-continue",
    projectIds: [],
    attachments: [],
  })

  assert.equal(result.message, WORKSPACE_CHAT_CONTINUATION_PROMPT)
  assert.equal(result.continuationOf, "assistant-1")
  assert.equal(
    combineWorkspaceChatContinuation("Partial ", "answer."),
    "Partial answer."
  )
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        chatId: "chat-1",
        continuationOf: "assistant-1",
        clientMessageId: "message-continue-2",
        projectIds: ["project-1"],
        attachments: [],
      }),
    /cannot add context/
  )
})

test("buildWorkspaceChatPrompt labels attached material as untrusted", () => {
  const request = parseWorkspaceChatRequest({
    message: "What connects these ideas?",
    projectId: "project-1",
    clientMessageId: "message-3",
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

test("buildWorkspaceChatPrompt gives an attached card its source context", () => {
  const request = parseWorkspaceChatRequest({
    message: "Explain the card in another way",
    projectId: "project-1",
    clientMessageId: "message-card-prompt",
    card: { projectId: "project-1", itemId: "item-1" },
    projectIds: [],
    attachments: [],
  })
  const card: WorkspaceChatCardContext = {
    id: "item-1" as Id<"learningItems">,
    projectId: "project-1" as Id<"projects">,
    title: "Cell membrane",
    body: "The membrane controls what enters and leaves the cell.",
    deepExplanation:
      "Selective permeability lets the membrane regulate movement between the cell and its surroundings.",
    question: "What does the membrane control?",
    options: ["Cell traffic", "Gravity"],
    sourceLabel: "cells.md",
    source: {
      filename: "cells.md",
      kind: "markdown",
      extractedText: "The membrane is selectively permeable.",
    },
  }
  const prompt = buildWorkspaceChatPrompt(request, [], card)

  assert.match(prompt, /CARD: Cell membrane/)
  assert.match(prompt, /CARD SOURCE CONTEXT:/)
  assert.match(prompt, /Detailed explanation: Selective permeability/)
  assert.match(prompt, /selectively permeable/)
  assert.match(prompt, /primary evidence/)
})

test("new workspace chats do not require an owning project", () => {
  const result = parseWorkspaceChatRequest({
    message: "Start without a project",
    clientMessageId: "message-no-project",
    projectIds: [],
    attachments: [],
  })

  assert.equal(result.message, "Start without a project")
  assert.equal(result.projectId, undefined)
})
