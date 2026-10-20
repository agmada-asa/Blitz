/** Exercises provider interaction lifecycles through the real Convex handlers and bridge. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createChatAgentSession } from "../lib/server/chat-agent.ts"
import {
  genericApprovalRequest,
  userInputResponse,
} from "../lib/server/agent-request.ts"

type Row = { _id: string; table: string; [key: string]: unknown }
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Small Convex-like database used to exercise production mutations and queries. */
class MemoryDb {
  rows: Row[] = []
  /** Inserts a row and returns a deterministic Convex-shaped ID. */
  seed(table: string, fields: Record<string, unknown>): string {
    const id = `${table}:${this.rows.length}`
    this.rows.push({ _id: id, table, ...fields })
    return id
  }
  /** Reads one row by ID. */
  async get(id: string): Promise<Row | null> {
    return this.rows.find((row) => row._id === id) ?? null
  }
  /** Applies a Convex patch, removing fields assigned undefined. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const row = await this.get(id)
    if (!row) throw new Error(`Missing row ${id}`)
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key]
      else row[key] = value
    }
  }
}

/** Loads actual chat agent handlers despite Convex's generated extensionless imports. */
async function loadHandlers() {
  type C = { conditions: string[]; parentURL?: string }
  type R = { url: string; format?: string }
  type N = (s: string, c: C) => R
  type H = {
    registerHooks: (h: { resolve: (s: string, c: C, n: N) => R }) => {
      deregister: () => void
    }
  }
  const { registerHooks } = (await import("node:module")) as unknown as H
  const hooks = registerHooks({
    resolve(s, c, n) {
      try {
        return n(s, c)
      } catch (e) {
        if (
          s.startsWith(".") &&
          e &&
          typeof e === "object" &&
          "code" in e &&
          e.code === "ERR_MODULE_NOT_FOUND"
        )
          for (const x of [".js", ".ts"])
            try {
              return n(s + x, c)
            } catch {
              /* continue */
            }
        throw e
      }
    },
  })
  try {
    const loaded =
      (await import("../convex/chatAgents.ts")) as unknown as Record<
        string,
        { _handler: Handler }
      >
    return Object.fromEntries(
      Object.entries(loaded).map(([name, value]) => [name, value._handler])
    ) as Record<string, Handler>
  } finally {
    hooks.deregister()
  }
}

/** Seeds an active assistant turn and returns its real Convex IDs. */
function activeTurn(db: MemoryDb): { chatId: string; messageId: string } {
  const chatId = db.seed("workspaceChats", {
    status: "running",
    agentAutonomy: "approval",
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
  })
  void db.patch(chatId, { activeMessageId: messageId })
  return { chatId, messageId }
}

/** Routes bridge calls to production Convex handler functions. */
function clientFor(db: MemoryDb, handlers: Record<string, Handler>) {
  const mutations: Array<Record<string, unknown>> = []
  return {
    mutations,
    client: {
      async mutation(_ref: unknown, args: Record<string, unknown>) {
        mutations.push(args)
        return args.approval
          ? handlers.requestApproval({ db }, args)
          : handlers.clearApproval({ db }, args)
      },
      async query(_ref: unknown, args: Record<string, unknown>) {
        return handlers.getApproval({ db }, args)
      },
    },
  }
}

/** Waits for production persistence to expose a pending interaction. */
async function waitForPending(
  db: MemoryDb,
  messageId: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const approval = (await db.get(messageId))?.agentApproval
    if (
      approval &&
      typeof approval === "object" &&
      (approval as Record<string, unknown>).status === "pending"
    )
      return approval as Record<string, unknown>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for persisted interaction")
}

/** Creates a bridge backed by production handlers and an active assistant turn. */
async function setup() {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const ids = activeTurn(db)
  const fake = clientFor(db, handlers)
  const bridge = createChatAgentSession({
    client: fake.client as never,
    chatId: ids.chatId as never,
    messageId: ids.messageId as never,
    workspaceDirectory: "/tmp/blitz-test",
    autonomy: "approval",
    additionalInstructions: "",
    approvalPolicy: "on-request",
    signal: new AbortController().signal,
    send: () => undefined,
  })
  return { ...ids, db, fake, handlers, bridge }
}

test("Claude AskUserQuestion preserves single and multi-select normalized UI answers", () => {
  const details = JSON.stringify({
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Environment?",
          header: "Env",
          options: [{ label: "Dev" }, { label: "Prod" }],
        },
      ],
    },
  })
  const single = genericApprovalRequest("claude/can_use_tool", details)
  assert.equal(single?.kind, "question")
  assert.deepEqual(
    userInputResponse(
      single?.input,
      true,
      JSON.stringify({ answers: { "Environment?": { answers: ["Prod"] } } })
    ),
    { answers: { "Environment?": { answers: ["Prod"] } } }
  )
  const multi = genericApprovalRequest(
    "claude/can_use_tool",
    JSON.stringify({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Topics?",
            header: "Topics",
            multiSelect: true,
            options: [{ label: "Math" }, { label: "Science" }],
          },
        ],
      },
    })
  )
  assert.deepEqual(
    userInputResponse(
      multi?.input,
      true,
      JSON.stringify({
        answers: { "Topics?": { answers: ["Math", "Science"] } },
      })
    ),
    { answers: { "Topics?": { answers: ["Math", "Science"] } } }
  )
})

test("ACP approvals preserve once, always, and reject IDs through one-time persistence", async () => {
  for (const [decision, expected] of [
    ["once", "once"],
    ["always", "always"],
    ["reject", undefined],
  ] as const) {
    const { bridge, db, messageId, handlers, chatId } = await setup()
    const result = bridge.handleProviderRequest({
      requestId: decision,
      method: "session/request_permission",
      params: {
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    })
    const approval = await waitForPending(db, messageId)
    await handlers.decideApproval(
      { db },
      {
        chatId,
        messageId,
        approvalId: approval.id,
        decision: decision === "reject" ? "denied" : "approved",
        response:
          decision === "reject"
            ? undefined
            : JSON.stringify({ optionId: decision }),
      }
    )
    assert.deepEqual(
      await result,
      expected
        ? { outcome: { outcome: "selected", optionId: expected } }
        : { outcome: { outcome: "cancelled" } }
    )
    await bridge.close()
  }
})

test("disconnect cancels pending interaction and records terminal history", async () => {
  const { bridge, db, messageId } = await setup()
  const result = bridge.handleProviderRequest({
    requestId: 9,
    method: "session/request_permission",
    params: {
      options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
    },
  })
  await waitForPending(db, messageId)
  await bridge.close()
  assert.deepEqual(await result, { outcome: { outcome: "cancelled" } })
  const message = await db.get(messageId)
  assert.equal(
    (message?.agentApproval as Record<string, unknown>)?.status,
    "cancelled"
  )
  assert.equal(
    (message?.agentRequests as Array<Record<string, unknown>>)?.[0]?.status,
    "cancelled"
  )
})

test("queued provider requests are serialized and each receives its own decision", async () => {
  const { bridge, db, messageId, handlers, chatId, fake } = await setup()
  const first = bridge.handleProviderRequest({
    requestId: "first",
    method: "session/request_permission",
    params: {
      options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    },
  })
  const firstApproval = await waitForPending(db, messageId)
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: firstApproval.id,
      decision: "approved",
      response: JSON.stringify({ optionId: "once" }),
    }
  )
  const second = bridge.handleProviderRequest({
    requestId: "second",
    method: "session/request_permission",
    params: {
      options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
    },
  })
  const secondApproval = await waitForPending(db, messageId)
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: secondApproval.id,
      decision: "approved",
      response: JSON.stringify({ optionId: "always" }),
    }
  )
  assert.deepEqual(await Promise.all([first, second]), [
    { outcome: { outcome: "selected", optionId: "once" } },
    { outcome: { outcome: "selected", optionId: "always" } },
  ])
  assert.equal(fake.mutations.filter((entry) => entry.approval).length, 2)
  await bridge.close()
})
