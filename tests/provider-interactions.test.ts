/** Exercises provider interaction lifecycles through the real Convex handlers and bridge. */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { AgentRequest } from "agent-engines"
import { createChatAgentSession } from "../lib/server/chat-agent.ts"
import { BLITZ_REQUEST_USER_INPUT_TOOL } from "../lib/server/agent-request.ts"

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
async function setup(approvalPolicy: "on-request" | "never" = "on-request") {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const ids = activeTurn(db)
  const fake = clientFor(db, handlers)
  const bridge = createChatAgentSession({
    client: fake.client as never,
    chatId: ids.chatId as never,
    messageId: ids.messageId as never,
    autonomy: "approval",
    approvalPolicy,
    signal: new AbortController().signal,
    send: () => undefined,
  })
  return { ...ids, db, fake, handlers, bridge }
}

test("Claude AskUserQuestion answers reach the runtime through one persisted interaction", async () => {
  const { bridge, db, messageId, handlers, chatId } = await setup()
  const answers: unknown[] = []
  const request: AgentRequest = {
    kind: "question",
    id: "toolu_1",
    raw: {},
    questions: [
      {
        id: "Topics?",
        header: "Topics",
        question: "Topics?",
        options: [
          { label: "Math", description: "" },
          { label: "Science", description: "" },
        ],
        multiSelect: true,
        allowOther: true,
        secret: false,
      },
    ],
    respond: async (answer) => {
      answers.push(answer)
    },
  }
  const handled = bridge.handleRequest(request, "claude-code")
  const pending = await waitForPending(db, messageId)
  assert.equal(pending.kind, "question")
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: pending.id,
      decision: "approved",
      response: JSON.stringify({
        answers: { "Topics?": { answers: ["Math", "Science"] } },
      }),
    }
  )
  await handled
  assert.deepEqual(answers, [{ "Topics?": ["Math", "Science"] }])
  await bridge.close()
})

test("Codex approvals are refused unseen when approvals are off, but Blitz's own tools still ask", async () => {
  const { bridge, db, messageId, handlers, chatId } = await setup("never")
  const decisions: unknown[] = []
  await bridge.handleRequest(
    {
      kind: "approval",
      id: "a1",
      action: "command",
      title: "Run ls",
      command: "ls",
      raw: { command: "ls" },
      respond: async (decision) => {
        decisions.push(decision)
      },
    },
    "codex"
  )
  assert.deepEqual(decisions, [{ decision: "deny" }])
  assert.equal((await db.get(messageId))?.agentApproval, undefined)
  // The chat agent's policy reaches Codex with Blitz's tools and live search.
  assert.equal(bridge.codex.thread?.approvalsReviewer, "user")
  assert.equal(bridge.codex.thread?.config?.web_search, "live")
  const answer = bridge.codex.onToolCall!({
    threadId: "t",
    turnId: "u",
    callId: "call-1",
    tool: BLITZ_REQUEST_USER_INPUT_TOOL,
    namespace: null,
    arguments: {
      questions: [
        {
          id: "label",
          header: "Label",
          question: "Which label?",
          options: [{ label: "Alpha" }, { label: "Beta" }],
        },
      ],
    },
  })
  const pending = await waitForPending(db, messageId)
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: pending.id,
      decision: "approved",
      response: JSON.stringify({ answers: { label: { answers: ["Beta"] } } }),
    }
  )
  assert.deepEqual(await answer, {
    text: JSON.stringify({
      accepted: true,
      answers: { label: { answers: ["Beta"] } },
    }),
    success: true,
  })
  await bridge.close()
})

/** Builds one OpenCode permission request as the ACP engine raises it. */
function openCodeApproval(
  id: string,
  decisions: unknown[],
  kinds: readonly string[] = ["allow_once", "allow_always", "reject_once"]
): AgentRequest {
  return {
    kind: "approval",
    id,
    action: "command",
    title: "bash",
    command: "ls",
    raw: {
      sessionId: "session-1",
      toolCall: { toolCallId: id, title: "bash", kind: "execute" },
      options: kinds.map((kind) => ({ optionId: kind, name: kind, kind })),
    },
    respond: async (decision) => {
      decisions.push(decision)
    },
  }
}

test("OpenCode approvals allow once, allow for the session, or deny through one-time persistence", async () => {
  for (const [choice, expected] of [
    ["accept", "allow"],
    ["acceptForSession", "allow-session"],
    ["deny", "deny"],
  ] as const) {
    const { bridge, db, messageId, handlers, chatId } = await setup()
    const decisions: unknown[] = []
    const handled = bridge.handleRequest(
      openCodeApproval(choice, decisions),
      "opencode"
    )
    const approval = await waitForPending(db, messageId)
    assert.deepEqual(
      (JSON.parse(String(approval.input)) as { approvalOptions: unknown })
        .approvalOptions,
      [
        { value: "accept", label: "Allow once" },
        { value: "acceptForSession", label: "Allow for this session" },
      ]
    )
    await handlers.decideApproval(
      { db },
      {
        chatId,
        messageId,
        approvalId: approval.id,
        decision: choice === "deny" ? "denied" : "approved",
        response:
          choice === "deny" ? undefined : JSON.stringify({ optionId: choice }),
      }
    )
    await handled
    assert.deepEqual(decisions, [{ decision: expected }])
    await bridge.close()
  }
})

test("OpenCode approvals with no allow-once choice are refused unseen", async () => {
  const { bridge, db, messageId } = await setup()
  const decisions: unknown[] = []
  await bridge.handleRequest(
    openCodeApproval("always-only", decisions, ["allow_always", "reject_once"]),
    "opencode"
  )
  assert.deepEqual(decisions, [{ decision: "deny" }])
  assert.equal((await db.get(messageId))?.agentApproval, undefined)
  await bridge.close()
})

test("disconnect cancels pending interaction and records terminal history", async () => {
  const { bridge, db, messageId } = await setup()
  const decisions: unknown[] = []
  const handled = bridge.handleRequest(
    openCodeApproval("pending", decisions),
    "opencode"
  )
  await waitForPending(db, messageId)
  await bridge.close()
  // The turn refuses an unanswered request itself once the wait ends.
  await handled.catch(() => undefined)
  assert.deepEqual(decisions, [])
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
  const decisions: unknown[] = []
  const first = bridge.handleRequest(
    openCodeApproval("first", decisions),
    "opencode"
  )
  const second = bridge.handleRequest(
    openCodeApproval("second", decisions),
    "opencode"
  )
  const firstApproval = await waitForPending(db, messageId)
  assert.equal(firstApproval.providerRequestId, "first")
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: firstApproval.id,
      decision: "approved",
      response: JSON.stringify({ optionId: "accept" }),
    }
  )
  await first
  const secondApproval = await waitForPending(db, messageId)
  assert.equal(secondApproval.providerRequestId, "second")
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: secondApproval.id,
      decision: "denied",
    }
  )
  await second
  assert.deepEqual(decisions, [{ decision: "allow" }, { decision: "deny" }])
  assert.equal(fake.mutations.filter((entry) => entry.approval).length, 2)
  await bridge.close()
})
