/** Verifies pause/play and steering functionality for workspace chat continuations. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  parseWorkspaceChatRequest,
  workspaceChatContinuationPrompt,
  WORKSPACE_CHAT_CONTINUATION_PROMPT,
} from "../lib/server/workspace-chat.ts"
import {
  hasChatRun,
  pauseAndAwaitChatRun,
  registerChatRun,
} from "../lib/server/chat-run-registry.ts"

test("workspaceChatContinuationPrompt generates default or steered instructions", () => {
  assert.equal(
    workspaceChatContinuationPrompt(),
    WORKSPACE_CHAT_CONTINUATION_PROMPT
  )
  assert.equal(
    workspaceChatContinuationPrompt("   "),
    WORKSPACE_CHAT_CONTINUATION_PROMPT
  )
  const steered = workspaceChatContinuationPrompt(
    "Focus only on the third recommendation and keep it brief."
  )
  assert.match(steered, /Continue the interrupted response from where it stopped\./)
  assert.match(
    steered,
    /Steer the remainder of the response using the following learner notes: "Focus only on the third recommendation and keep it brief\."/
  )
  assert.match(steered, /Do not repeat text that was already completed\./)
})

test("parseWorkspaceChatRequest parses and bounds steeringPrompt on continuation", () => {
  const resultWithExplicitSteering = parseWorkspaceChatRequest({
    chatId: "chat-1",
    continuationOf: "assistant-1",
    steeringPrompt: "  Be concise and use bullets.  ",
    clientMessageId: "msg-steer-1",
    projectIds: [],
    attachments: [],
  })

  assert.equal(resultWithExplicitSteering.continuationOf, "assistant-1")
  assert.equal(
    resultWithExplicitSteering.steeringPrompt,
    "Be concise and use bullets."
  )
  assert.match(
    resultWithExplicitSteering.message,
    /Steer the remainder of the response using the following learner notes: "Be concise and use bullets\."/
  )

  const resultWithMessageAsSteering = parseWorkspaceChatRequest({
    chatId: "chat-1",
    continuationOf: "assistant-1",
    message: "Redirect to step 2",
    clientMessageId: "msg-steer-2",
    projectIds: [],
    attachments: [],
  })
  assert.equal(
    resultWithMessageAsSteering.steeringPrompt,
    "Redirect to step 2"
  )
  assert.match(
    resultWithMessageAsSteering.message,
    /Steer the remainder of the response using the following learner notes: "Redirect to step 2"/
  )
})

test("parseWorkspaceChatRequest rejects oversized steeringPrompt", () => {
  const oversized = "a".repeat(2_001)
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        chatId: "chat-1",
        continuationOf: "assistant-1",
        steeringPrompt: oversized,
        clientMessageId: "msg-steer-oversized",
        projectIds: [],
        attachments: [],
      }),
    /Steering notes are too long/
  )
})

test("parseWorkspaceChatRequest still forbids attachments when steering continuation", () => {
  assert.throws(
    () =>
      parseWorkspaceChatRequest({
        chatId: "chat-1",
        continuationOf: "assistant-1",
        steeringPrompt: "Steer this",
        clientMessageId: "msg-steer-forbidden",
        projectIds: ["proj-1"],
        attachments: [],
      }),
    /Continuing a response cannot add context/
  )
})

test("pauseAndAwaitChatRun aborts controller and awaits completion", async () => {
  const controller = new AbortController()
  let finished = false
  const cleanup = registerChatRun(
    "chat-steer-test",
    "msg-steer-test",
    controller,
    Date.now() + 10_000
  )

  assert.equal(hasChatRun("chat-steer-test", "msg-steer-test"), true)

  // Simulate background cleanup on abort
  controller.signal.addEventListener("abort", () => {
    setTimeout(() => {
      finished = true
      cleanup()
    }, 20)
  })

  const paused = await pauseAndAwaitChatRun(
    "chat-steer-test",
    "msg-steer-test",
    500
  )
  assert.equal(paused, true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(finished, true)
  assert.equal(hasChatRun("chat-steer-test", "msg-steer-test"), false)
})
