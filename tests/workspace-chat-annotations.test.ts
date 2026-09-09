/**
 * Tests workspace chat annotation validation and prompt injection.
 *
 * Verifies that parseWorkspaceChatRequest validates annotation counts, lengths, and
 * properties, and that buildWorkspaceChatPrompt injects clear instructions and hyperlinking
 * guidance for the assistant model to reference annotations.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildWorkspaceChatPrompt,
  parseWorkspaceChatRequest,
} from "../lib/server/workspace-chat.ts"

test("parseWorkspaceChatRequest accepts valid annotations", () => {
  const result = parseWorkspaceChatRequest({
    message: "Can you elaborate on this part?",
    chatId: "chat-1",
    clientMessageId: "msg-1",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-1",
        number: 1,
        messageId: "assistant-msg-1",
        selectedText: "mitochondria is the powerhouse",
        note: "Is this still accurate in modern cell biology?",
      },
    ],
  })

  assert.equal(result.annotations?.length, 1)
  assert.equal(result.annotations?.[0]?.id, "ann-1")
  assert.equal(result.annotations?.[0]?.number, 1)
  assert.equal(result.annotations?.[0]?.messageId, "assistant-msg-1")
  assert.equal(
    result.annotations?.[0]?.selectedText,
    "mitochondria is the powerhouse"
  )
  assert.equal(
    result.annotations?.[0]?.note,
    "Is this still accurate in modern cell biology?"
  )
})

test("parseWorkspaceChatRequest trims annotation fields", () => {
  const result = parseWorkspaceChatRequest({
    message: "Check this note",
    chatId: "chat-1",
    clientMessageId: "msg-2",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-2",
        messageId: "assistant-msg-1",
        selectedText: "  whitespace around text  ",
        note: "   some note text   ",
      },
    ],
  })

  assert.equal(result.annotations?.[0]?.selectedText, "whitespace around text")
  assert.equal(result.annotations?.[0]?.note, "some note text")
})

test("parseWorkspaceChatRequest rejects annotations that exceed the maximum count", () => {
  const oversizedAnnotations = Array.from({ length: 21 }, (_, i) => ({
    id: `ann-${i}`,
    number: i + 1,
    messageId: "msg-1",
    selectedText: `Selected snippet ${i}`,
    note: `Note ${i}`,
  }))

  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Too many annotations",
        chatId: "chat-1",
        clientMessageId: "msg-3",
        projectIds: ["project-1"],
        attachments: [],
        annotations: oversizedAnnotations,
      }),
    /Attach at most 20 annotations/
  )
})

test("parseWorkspaceChatRequest rejects empty or blank selectedText", () => {
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Blank quote",
        chatId: "chat-1",
        clientMessageId: "msg-4",
        projectIds: ["project-1"],
        attachments: [],
        annotations: [
          {
            id: "ann-1",
            messageId: "msg-1",
            selectedText: "   ",
            note: "Note without quote",
          },
        ],
      }),
    /Quoted text is required/
  )
})

test("parseWorkspaceChatRequest rejects oversized note", () => {
  const hugeNote = "a".repeat(2_001)
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Oversized note",
        chatId: "chat-1",
        clientMessageId: "msg-5",
        projectIds: ["project-1"],
        attachments: [],
        annotations: [
          {
            id: "ann-1",
            messageId: "msg-1",
            selectedText: "Valid text",
            note: hugeNote,
          },
        ],
      }),
    /Annotation note must be 2,000 characters or fewer/
  )
})

test("parseWorkspaceChatRequest rejects oversized selectedText", () => {
  const hugeText = "b".repeat(1_001)
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        message: "Oversized quote",
        chatId: "chat-1",
        clientMessageId: "msg-6",
        projectIds: ["project-1"],
        attachments: [],
        annotations: [
          {
            id: "ann-1",
            messageId: "msg-1",
            selectedText: hugeText,
            note: "Short note",
          },
        ],
      }),
    /Quoted text is too long/
  )
})

test("parseWorkspaceChatRequest rejects annotations on continuation requests", () => {
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        chatId: "chat-1",
        continuationOf: "assistant-1",
        clientMessageId: "msg-continue",
        projectIds: [],
        attachments: [],
        annotations: [
          {
            id: "ann-1",
            messageId: "msg-1",
            selectedText: "Something",
            note: "Something else",
          },
        ],
      }),
    /cannot add context/
  )
})

test("buildWorkspaceChatPrompt formats annotations and includes hyperlinking instructions", () => {
  const request = parseWorkspaceChatRequest({
    message: "Please explain these two points",
    chatId: "chat-1",
    clientMessageId: "msg-7",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-1",
        number: 1,
        messageId: "assistant-msg-1",
        selectedText: "cellular respiration occurs in the cristae",
        note: "Does this include the Krebs cycle too?",
      },
      {
        id: "ann-2",
        number: 2,
        messageId: "assistant-msg-1",
        selectedText: "anaerobic glycolysis",
        note: "How efficient is this in humans?",
      },
    ],
  })

  const prompt = buildWorkspaceChatPrompt(request, [])

  assert.match(prompt, /USER ANNOTATIONS ON PREVIOUS REPLIES:/)
  assert.match(prompt, /\[Annotation 1\]/)
  assert.match(
    prompt,
    /Quoted text from previous reply: "cellular respiration occurs in the cristae"/
  )
  assert.match(
    prompt,
    /User note: "Does this include the Krebs cycle too\?"/
  )
  assert.match(prompt, /\[Annotation 2\]/)
  assert.match(
    prompt,
    /Quoted text from previous reply: "anaerobic glycolysis"/
  )
  assert.match(prompt, /User note: "How efficient is this in humans\?"/)
  assert.match(
    prompt,
    /markdown links formatted as \[Annotation N\]\(annotation:N\)/
  )
})

test("parseWorkspaceChatRequest allows empty message when annotations are present", () => {
  const result = parseWorkspaceChatRequest({
    message: "",
    chatId: "chat-1",
    clientMessageId: "msg-8",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-1",
        number: 1,
        messageId: "assistant-msg-1",
        selectedText: "some quote",
        note: "my note",
      },
    ],
  })

  assert.equal(result.message, "")
  assert.equal(result.annotations?.length, 1)
})

test("buildWorkspaceChatPrompt injects instruction when user message is empty but annotations exist", () => {
  const request = parseWorkspaceChatRequest({
    message: "   ",
    chatId: "chat-1",
    clientMessageId: "msg-9",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-1",
        number: 1,
        messageId: "assistant-msg-1",
        selectedText: "some quote",
        note: "my note",
      },
    ],
  })

  const prompt = buildWorkspaceChatPrompt(request, [])
  assert.match(
    prompt,
    /USER MESSAGE BEGIN\nPlease address the attached annotations on your previous response\.\nUSER MESSAGE END/
  )
})

test("buildWorkspaceChatPrompt preserves typed user message when annotations exist", () => {
  const request = parseWorkspaceChatRequest({
    message: "Check these points please",
    chatId: "chat-1",
    clientMessageId: "msg-10",
    projectIds: ["project-1"],
    attachments: [],
    annotations: [
      {
        id: "ann-1",
        number: 1,
        messageId: "assistant-msg-1",
        selectedText: "some quote",
        note: "my note",
      },
    ],
  })

  const prompt = buildWorkspaceChatPrompt(request, [])
  assert.match(
    prompt,
    /USER MESSAGE BEGIN\nCheck these points please\nUSER MESSAGE END/
  )
})
