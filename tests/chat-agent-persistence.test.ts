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
  assert.deepEqual(first, { resetContext: false })
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
        approval?: unknown
      }
    ).approval,
    undefined
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
