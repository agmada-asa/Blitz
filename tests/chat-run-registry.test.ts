/** Verifies exact identity, expiry, duplicate protection, and cleanup for active chat runs. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  hasChatRun,
  pauseChatRun,
  registerChatRun,
} from "../lib/server/chat-run-registry.ts"

test("pauses only the exact registered chat run", () => {
  const first = new AbortController()
  const second = new AbortController()
  const cleanupFirst = registerChatRun(
    "chat-a",
    "message-a",
    first,
    Date.now() + 10_000
  )
  const cleanupSecond = registerChatRun(
    "chat-b",
    "message-b",
    second,
    Date.now() + 10_000
  )

  assert.equal(pauseChatRun("chat-a", "message-b"), false)
  assert.equal(first.signal.aborted, false)
  assert.equal(pauseChatRun("chat-a", "message-a"), true)
  assert.equal(first.signal.aborted, true)
  assert.equal(hasChatRun("chat-a", "message-a"), false)
  assert.equal(second.signal.aborted, false)
  cleanupFirst()
  cleanupSecond()
})

test("rejects duplicate identities and cleanup cannot remove a replacement", () => {
  const first = new AbortController()
  const cleanupFirst = registerChatRun(
    "chat-duplicate",
    "message",
    first,
    Date.now() + 10_000
  )
  assert.throws(
    () =>
      registerChatRun(
        "chat-duplicate",
        "message",
        new AbortController(),
        Date.now() + 10_000
      ),
    /already active/
  )
  cleanupFirst()
  const second = new AbortController()
  const cleanupSecond = registerChatRun(
    "chat-duplicate",
    "message",
    second,
    Date.now() + 10_000
  )
  cleanupFirst()
  assert.equal(hasChatRun("chat-duplicate", "message"), true)
  cleanupSecond()
})

test("expires a run and aborts its controller", () => {
  const controller = new AbortController()
  registerChatRun("chat-expiry", "message", controller, Date.now() + 1)
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(pauseChatRun("chat-expiry", "message"), false)
      assert.equal(controller.signal.aborted, true)
      resolve()
    }, 5)
  })
})
