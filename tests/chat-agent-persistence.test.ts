/** Verifies chat agent settings and approval persistence at the Convex mutation boundary. */
import assert from "node:assert/strict"
import test from "node:test"

type Row = { _id: string; table: string; [key: string]: unknown }
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Minimal in-memory database supporting the chat agent handlers under test. */
class MemoryDb {
  rows: Row[] = []

  /** Seeds a document and returns its deterministic test ID. */
  seed(table: string, fields: Record<string, unknown>): string {
    const id = `${table}:${this.rows.length}`
    this.rows.push({ _id: id, table, ...fields })
    return id
  }

  /** Reads one seeded document. */
  async get(id: string): Promise<Row | null> {
    return this.rows.find((row) => row._id === id) ?? null
  }

  /** Applies a Convex-like patch, removing fields assigned undefined. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const row = await this.get(id)
    if (!row) throw new Error("missing row")
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key]
      else row[key] = value
    }
  }
}

/** Loads chat agent handlers with the same extension resolver used by persistence tests. */
async function loadHandlers() {
  type ResolveContext = { conditions: string[]; parentURL?: string }
  type ResolveResult = { url: string; format?: string }
  type NextResolve = (
    specifier: string,
    context: ResolveContext
  ) => ResolveResult
  type ModuleHooks = {
    registerHooks: (hooks: {
      resolve: (
        specifier: string,
        context: ResolveContext,
        nextResolve: NextResolve
      ) => ResolveResult
    }) => { deregister: () => void }
  }
  const { registerHooks } =
    (await import("node:module")) as unknown as ModuleHooks
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (
          specifier.startsWith(".") &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ERR_MODULE_NOT_FOUND"
        ) {
          for (const suffix of [".js", ".ts"]) {
            try {
              return nextResolve(specifier + suffix, context)
            } catch {
              /* Try the next local extension. */
            }
          }
        }
        throw error
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

const approval = (expiresAt = Date.now() + 60_000) => ({
  id: "approval-1",
  method: "item/fileChange",
  details: "Change file",
  expiresAt,
})

test("configure reports context resets and rejects unknown projects", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", { status: "idle" })
  const projectId = db.seed("projects", {})
  const first = await handlers.configure(
    { db },
    {
      chatId,
      autonomy: "approval",
      additionalInstructions: "",
      workingProjectId: undefined,
    }
  )
  assert.deepEqual(first, { resetContext: true })
  const changed = await handlers.configure(
    { db },
    {
      chatId,
      autonomy: "full",
      additionalInstructions: "Use concise replies",
      workingProjectId: projectId,
    }
  )
  assert.deepEqual(changed, { resetContext: true })
  const unchanged = await handlers.configure(
    { db },
    {
      chatId,
      autonomy: "full",
      additionalInstructions: "Use concise replies",
      workingProjectId: projectId,
    }
  )
  assert.deepEqual(unchanged, { resetContext: false })
  await assert.rejects(
    handlers.configure(
      { db },
      {
        chatId,
        autonomy: "full",
        additionalInstructions: "",
        workingProjectId: "projects:missing",
      }
    ),
    /Project not found/
  )
})

test("approval remains active after decision until the running turn completes", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    status: "running",
    agentAutonomy: "approval",
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
  })
  await db.patch(chatId, { activeMessageId: messageId })
  const pending = await handlers.requestApproval(
    { db },
    { chatId, messageId, approval: approval() }
  )
  assert.equal((pending as { status: string }).status, "pending")
  await assert.rejects(
    handlers.requestApproval(
      { db },
      { chatId, messageId, approval: approval() }
    ),
    /already pending/
  )
  const decided = await handlers.decideApproval(
    { db },
    { chatId, messageId, approvalId: "approval-1", decision: "approved" }
  )
  assert.equal((decided as { success: boolean }).success, true)
  const state = (await handlers.getApproval({ db }, { chatId, messageId })) as {
    approval: { status: string }
    active: boolean
  }
  assert.equal(state.approval.status, "approved")
  assert.equal(state.active, true)
  await assert.rejects(
    handlers.decideApproval(
      { db },
      { chatId, messageId, approvalId: "approval-1", decision: "denied" }
    ),
    /no longer available/
  )
  await handlers.clearApproval({ db }, { chatId, messageId })
  assert.equal(
    (
      (await handlers.getApproval({ db }, { chatId, messageId })) as {
        approval: { status: string }
      }
    ).approval.status,
    "approved"
  )
})

test("approval guards reject mismatched scope, non-running turns, and expiry", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    status: "running",
    agentAutonomy: "approval",
  })
  const otherChatId = db.seed("workspaceChats", {
    status: "running",
    agentAutonomy: "approval",
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
  })
  const userMessageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "user",
    status: "running",
  })
  await db.patch(chatId, { activeMessageId: messageId })
  await assert.rejects(
    handlers.requestApproval(
      { db },
      { chatId: otherChatId, messageId, approval: approval() }
    ),
    /not found/
  )
  await assert.rejects(
    handlers.requestApproval(
      { db },
      { chatId, messageId: userMessageId, approval: approval() }
    ),
    /cannot request/
  )
  await assert.rejects(
    handlers.requestApproval(
      { db },
      { chatId, messageId, approval: approval(Date.now() - 1) }
    ),
    /invalid/
  )
  await handlers.requestApproval(
    { db },
    { chatId, messageId, approval: approval() }
  )
  await assert.rejects(
    handlers.decideApproval(
      { db },
      { chatId, messageId, approvalId: "wrong", decision: "approved" }
    ),
    /no longer available/
  )
  await assert.rejects(
    handlers.decideApproval(
      { db },
      {
        chatId: otherChatId,
        messageId,
        approvalId: "approval-1",
        decision: "approved",
      }
    ),
    /not found/
  )
  await db.patch(chatId, { status: "idle" })
  await assert.rejects(
    handlers.decideApproval(
      { db },
      { chatId, messageId, approvalId: "approval-1", decision: "approved" }
    ),
    /no longer available/
  )
})

test("structured agent requests persist responses outside approval autonomy", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    status: "running",
    agentAutonomy: "full",
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
  })
  await db.patch(chatId, { activeMessageId: messageId })
  const question = {
    ...approval(),
    kind: "question",
    title: "Blitz needs your input",
    input: JSON.stringify({
      questions: [
        {
          id: "audience",
          header: "Audience",
          question: "Who is this for?",
        },
      ],
    }),
  }
  await handlers.requestApproval(
    { db },
    { chatId, messageId, approval: question }
  )
  await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: question.id,
      decision: "approved",
      response: JSON.stringify({
        answers: { audience: { answers: ["Beginners"] } },
      }),
    }
  )
  const state = (await handlers.getApproval({ db }, { chatId, messageId })) as {
    approval: { kind: string; response: string }
  }
  assert.equal(state.approval.kind, "question")
  assert.equal(
    state.approval.response,
    JSON.stringify({ answers: { audience: { answers: ["Beginners"] } } })
  )

  await handlers.clearApproval({ db }, { chatId, messageId })
  const confirmation = {
    ...approval(),
    id: "confirmation-1",
    method: "item/tool/call",
    kind: "approval",
    title: "Confirm this step",
    prompt: "Continue with the requested action?",
  }
  await handlers.requestApproval(
    { db },
    { chatId, messageId, approval: confirmation }
  )
  const confirmed = await handlers.decideApproval(
    { db },
    {
      chatId,
      messageId,
      approvalId: confirmation.id,
      decision: "approved",
    }
  )
  assert.equal((confirmed as { success: boolean }).success, true)
})

test("secret answers are scrubbed from completed history while the live response remains available", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", { status: "running", agentAutonomy: "full" })
  const messageId = db.seed("workspaceChatMessages", { chatId, role: "assistant", status: "running" })
  await db.patch(chatId, { activeMessageId: messageId })
  const request = {
    id: "secret-question",
    method: "claude/can_use_tool",
    kind: "question",
    details: "question",
    input: JSON.stringify({ questions: [{ id: "token", question: "Token", isSecret: true }, { id: "name", question: "Name" }] }),
    expiresAt: Date.now() + 60_000,
  }
  await handlers.requestApproval({ db }, { chatId, messageId, approval: request })
  const response = JSON.stringify({ answers: { token: { answers: ["secret-value"] }, name: { answers: ["Ada"] } } })
  await handlers.decideApproval({ db }, { chatId, messageId, approvalId: request.id, decision: "approved", response })
  const message = await db.get(messageId)
  assert.equal((message?.agentApproval as Record<string, unknown>)?.response, response)
  const history = (message?.agentRequests as Array<Record<string, unknown>>)?.[0]
  assert.equal(history?.response, JSON.stringify({ answers: { name: { answers: ["Ada"] } } }))
  const reloaded = await handlers.getApproval({ db }, { chatId, messageId }) as { approval: Record<string, unknown>; active: boolean }
  assert.equal(reloaded.active, true)
  assert.equal(reloaded.approval.response, response)
})

test("expired, duplicate, stale, and wrong-chat decisions cannot resolve a request", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", { status: "running", agentAutonomy: "approval" })
  const otherChatId = db.seed("workspaceChats", { status: "running", agentAutonomy: "approval" })
  const messageId = db.seed("workspaceChatMessages", { chatId, role: "assistant", status: "running" })
  const otherMessageId = db.seed("workspaceChatMessages", { chatId: otherChatId, role: "assistant", status: "running" })
  await db.patch(chatId, { activeMessageId: messageId })
  await db.patch(otherChatId, { activeMessageId: otherMessageId })
  const request = { id: "pending", method: "session/request_permission", details: "permission", expiresAt: Date.now() + 60_000 }
  await handlers.requestApproval({ db }, { chatId, messageId, approval: request })
  await assert.rejects(handlers.requestApproval({ db }, { chatId, messageId, approval: { ...request, id: "duplicate" } }), /already pending/)
  await assert.rejects(handlers.decideApproval({ db }, { chatId: otherChatId, messageId, approvalId: request.id, decision: "approved" }), /not found/)
  await assert.rejects(handlers.decideApproval({ db }, { chatId, messageId, approvalId: "stale", decision: "approved" }), /no longer available/)
  await db.patch(messageId, { agentApproval: { ...request, status: "pending", expiresAt: Date.now() - 1 } })
  const expired = await handlers.getApproval({ db }, { chatId, messageId }) as { active: boolean }
  assert.equal(expired.active, false)
  await assert.rejects(handlers.decideApproval({ db }, { chatId, messageId, approvalId: request.id, decision: "approved" }), /no longer available/)
})

test("clearing an expired pending request terminalizes both live state and history", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", { status: "running", agentAutonomy: "approval" })
  const messageId = db.seed("workspaceChatMessages", { chatId, role: "assistant", status: "running" })
  await db.patch(chatId, { activeMessageId: messageId })
  const request = { id: "expired-request", method: "session/request_permission", details: "permission", expiresAt: Date.now() + 60_000 }
  await handlers.requestApproval({ db }, { chatId, messageId, approval: request })
  const message = await db.get(messageId)
  await db.patch(messageId, { agentApproval: { ...(message?.agentApproval as Record<string, unknown>), expiresAt: Date.now() - 1 } })
  await handlers.clearApproval({ db }, { chatId, messageId })
  const state = await handlers.getApproval({ db }, { chatId, messageId }) as { approval: Record<string, unknown>; active: boolean }
  assert.equal(state.active, false)
  assert.equal(state.approval.status, "expired")
  assert.equal(((await db.get(messageId))?.agentRequests as Array<Record<string, unknown>>)?.[0]?.status, "expired")
})

test("clear marks pending requests cancelled and keeps bounded completed history across reloads", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", { status: "running", agentAutonomy: "full" })
  const messageId = db.seed("workspaceChatMessages", { chatId, role: "assistant", status: "running" })
  await db.patch(chatId, { activeMessageId: messageId })
  for (let i = 0; i < 22; i++) {
    await handlers.requestApproval({ db }, { chatId, messageId, approval: { id: `request-${i}`, method: "item/tool/call", kind: "question", details: `request-${i}`, input: JSON.stringify({ questions: [{ id: "answer", question: "Answer" }] }), expiresAt: Date.now() + 60_000 } })
    await handlers.decideApproval({ db }, { chatId, messageId, approvalId: `request-${i}`, decision: "approved", response: JSON.stringify({ answers: { answer: { answers: [`${i}`] } } }) })
  }
  const state = await handlers.getApproval({ db }, { chatId, messageId }) as { approval: Record<string, unknown>; active: boolean }
  assert.equal(state.active, true)
  assert.equal(state.approval.status, "approved")
  const message = await db.get(messageId)
  const history = message?.agentRequests as Array<Record<string, unknown>>
  assert.equal(history.length, 20)
  assert.equal(history[0]?.id, "request-2")
  await handlers.clearApproval({ db }, { chatId, messageId })
  assert.equal((await handlers.getApproval({ db }, { chatId, messageId }) as { approval: Record<string, unknown> }).approval.status, "approved")
})
