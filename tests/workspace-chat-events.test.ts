/** Verifies how the chat workspace reads and checks the events `/api/chat` streams back. */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  agentRequestFromValue,
  parseChatEvent,
  readChatEvents,
  type ChatEvent,
} from "../lib/client/workspace-chat-events.ts"

/** Produces a byte stream split into packets of `size` bytes. */
function bytes(text: string, size = 1) {
  const data = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < data.length; i += size)
        controller.enqueue(data.slice(i, i + size))
      controller.close()
    },
  })
}

/** A pending agent request as the server sends it. */
const pendingRequest = {
  id: "request-1",
  method: "item/permissions/requestApproval",
  details: "Run a command",
  expiresAt: 1_000,
  status: "pending",
}

test("reads events split across packets, including a last line without a newline", async () => {
  const events: ChatEvent[] = []
  await readChatEvents(
    bytes(
      '{"type":"started","chatId":"c1"}\n\n{"type":"delta","text":"Hé"}\n{"type":"complete","chatId":"c1","threadId":"t1"}',
      3
    ),
    (event) => events.push(event)
  )
  assert.deepEqual(events, [
    { type: "started", chatId: "c1" },
    { type: "delta", text: "Hé" },
    { type: "complete", chatId: "c1", threadId: "t1" },
  ])
})

test("rejects events it does not recognise", async () => {
  assert.throws(() => parseChatEvent({ type: "delta" }), /invalid response/)
  assert.throws(() => parseChatEvent([]), /invalid response/)
  await assert.rejects(
    readChatEvents(bytes('{"type":"surprise"}\n'), () => {}),
    /invalid response/
  )
})

test("keeps only well-formed tool activity", () => {
  assert.deepEqual(
    parseChatEvent({
      type: "activity",
      event: { id: "a1", type: "tool", title: "Search", status: "running" },
    }),
    {
      type: "activity",
      event: { id: "a1", type: "tool", title: "Search", status: "running" },
    }
  )
  assert.throws(() =>
    parseChatEvent({
      type: "activity",
      event: { id: "a1", type: "tool", title: "Search", status: "paused" },
    })
  )
})

test("reads the notices the chat route streams beside a reply", async () => {
  // The exact line the route sends for a denied tool (tests/chat-route.test.ts).
  const notice = { kind: "permission-denied", message: "Writing files is off." }
  const events: ChatEvent[] = []
  await readChatEvents(
    bytes(
      `{"type":"started","chatId":"c1"}\n${JSON.stringify({ type: "notice", notice })}\n{"type":"delta","text":"Done"}\n`
    ),
    (event) => events.push(event)
  )
  assert.deepEqual(events, [
    { type: "started", chatId: "c1" },
    { type: "notice", notice },
    { type: "delta", text: "Done" },
  ])
  assert.throws(
    () => parseChatEvent({ type: "notice", notice: { kind: "warning", message: "x" } }),
    /invalid response/
  )
  assert.throws(() => parseChatEvent({ type: "notice" }), /invalid response/)
})

test("reads agent requests under both the current and the previous event names", () => {
  const current = parseChatEvent({
    type: "agent-request",
    chatId: "c1",
    messageId: "m1",
    request: { ...pendingRequest, kind: "question", title: " Pick one " },
  })
  assert.equal(current.type, "agent-request")
  assert.equal(current.type === "agent-request" && current.request.kind, "question")
  assert.equal(current.type === "agent-request" && current.request.title, "Pick one")

  const previous = parseChatEvent({
    type: "approval",
    chatId: "c1",
    messageId: "m1",
    approval: pendingRequest,
  })
  assert.equal(previous.type === "agent-request" && previous.request.kind, "approval")
  assert.deepEqual(
    parseChatEvent({ type: "approval-resolved", approvalId: "request-1" }),
    { type: "agent-request-resolved", requestId: "request-1" }
  )
})

test("ignores agent requests that are no longer pending", () => {
  assert.throws(() =>
    parseChatEvent({
      type: "agent-request",
      chatId: "c1",
      messageId: "m1",
      request: { ...pendingRequest, status: "approved" },
    })
  )
  assert.equal(
    agentRequestFromValue({ ...pendingRequest, status: "approved" })?.status,
    "approved"
  )
  assert.equal(agentRequestFromValue({ ...pendingRequest, status: "odd" }), undefined)
  assert.equal(agentRequestFromValue({ ...pendingRequest })?.title, "Review needed")
})
