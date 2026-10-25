/**
 * Exercises the Convex side of branching by fork, redoing a Teach reply,
 * compaction planning, Compact now, and saved notices, with the real
 * `workspaceChats` handlers over an in-memory database.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { savedChatReplySelection } from "../lib/server/teach-turn-settings.ts"

/** Minimal document representation used by the handler test double. */
type Row = { _id: string; table: string; [key: string]: unknown }
/** Handler interface keeps untrusted test arguments explicit. */
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Implements the indexed reads, writes, and deletes these handlers use. */
class MemoryDb {
  rows: Row[] = []
  /** Seeds a row and returns its test ID. */
  seed(table: string, data: Record<string, unknown>) {
    const id = `${table}_${this.rows.length}`
    this.rows.push({ _id: id, table, ...data })
    return id
  }
  /** Reads a test document. */
  async get(id: string) {
    return this.rows.find((row) => row._id === id) ?? null
  }
  /** Applies a patch, removing fields set to undefined as Convex does. */
  async patch(id: string, data: Record<string, unknown>) {
    const row = (await this.get(id))!
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) delete row[key]
      else row[key] = value
    }
  }
  /** Inserts a document. */
  async insert(table: string, data: Record<string, unknown>) {
    return this.seed(table, data)
  }
  /** Deletes a document. */
  async delete(id: string) {
    this.rows = this.rows.filter((row) => row._id !== id)
  }
  /** Supports chained equality filters, ordering, and bounded reads. */
  query(table: string) {
    const filters: Array<[string, unknown]> = []
    let direction = 1
    const index = {
      eq: (field: string, value: unknown) => {
        filters.push([field, value])
        return index
      },
    }
    const rows = () =>
      this.rows
        .filter(
          (row) =>
            row.table === table &&
            filters.every(([field, value]) => row[field] === value)
        )
        .sort(
          (a, b) => direction * (Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
        )
    const chain = {
      first: async (): Promise<Row | null> => rows()[0] ?? null,
      withIndex: (_name: string, callback: (q: typeof index) => unknown) => {
        callback(index)
        return chain
      },
      order: (order: string) => {
        direction = order === "desc" ? -1 : 1
        return chain
      },
      take: async (limit: number) => rows().slice(0, limit),
      collect: async () => rows(),
    }
    return chain
  }
}

/** Loads extensionless Convex imports with Node's repository-standard resolver. */
async function handlers(): Promise<Record<string, Handler>> {
  type ResolveContext = { conditions: string[]; parentURL?: string }
  type ResolveResult = { url: string; format?: string }
  const { registerHooks } = (await import("node:module")) as unknown as {
    registerHooks: (hooks: {
      resolve: (
        specifier: string,
        context: ResolveContext,
        next: (specifier: string, context: ResolveContext) => ResolveResult
      ) => ResolveResult
    }) => { deregister: () => void }
  }
  const hook = registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (specifier.startsWith("."))
          for (const suffix of [".js", ".ts"]) {
            try {
              return next(specifier + suffix, context)
            } catch {
              /* Try the next extension. */
            }
          }
        throw error
      }
    },
  })
  try {
    const chats = (await import("../convex/workspaceChats.ts")) as unknown as Record<
      string,
      { _handler: Handler }
    >
    return Object.fromEntries(
      Object.entries(chats)
        .filter(([, value]) => typeof value?._handler === "function")
        .map(([name, value]) => [name, value._handler])
    )
  } finally {
    hook.deregister()
  }
}

/** Seeds a chat with one finished request and reply pair per turn ID. */
function seedChat(
  db: MemoryDb,
  chat: Record<string, unknown>,
  turns: Array<{ request: string; reply: string; turnId?: string }>
) {
  const chatId = db.seed("workspaceChats", {
    title: "Fixture",
    status: "idle",
    codexContextReady: true,
    createdAt: 1,
    updatedAt: 1,
    ...chat,
  })
  const ids: string[] = []
  turns.forEach((turn, index) => {
    const clientMessageId = `client_${index}`
    ids.push(
      db.seed("workspaceChatMessages", {
        chatId,
        clientMessageId,
        role: "user",
        content: turn.request,
        status: "completed",
        createdAt: 10 + index * 10,
      }),
      db.seed("workspaceChatMessages", {
        chatId,
        clientMessageId,
        role: "assistant",
        content: turn.reply,
        status: "completed",
        ...(turn.turnId ? { providerTurnId: turn.turnId } : {}),
        createdAt: 11 + index * 10,
      })
    )
  })
  return { chatId, ids }
}

test("a branch copies the runtime session through its reply and shares the folder", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId, ids } = seedChat(
    db,
    { providerId: "claude-code", providerSessionId: "session_a" },
    [
      { request: "One", reply: "First", turnId: "turn_1" },
      { request: "Two", reply: "Second", turnId: "turn_2" },
    ]
  )
  const branch = (await api.branch!({ db }, { chatId, messageId: ids[1], includeMessage: true })) as {
    chatId: string
  }
  const branched = await db.get(branch.chatId)
  assert.deepEqual(branched?.forkSource, { sessionId: "session_a", throughTurnId: "turn_1" })
  assert.equal(branched?.workspaceFolderId, chatId)

  // Editing the second request copies through the reply before it.
  const edit = (await api.branch!(
    { db },
    { chatId, messageId: ids[2], includeMessage: false, editedMessage: "Two, again" }
  )) as { chatId: string }
  assert.deepEqual((await db.get(edit.chatId))?.forkSource, {
    sessionId: "session_a",
    throughTurnId: "turn_1",
  })

  // The branch's first turn copies the session; binding the copy clears it.
  const turn = (await api.startTurn!(
    { db },
    { chatId: branch.chatId, clientMessageId: "next", message: "Go on", attachments: [] }
  )) as { fork: unknown; workspaceFolderId: string; assistantMessageId: string }
  assert.deepEqual(turn.fork, { sessionId: "session_a", throughTurnId: "turn_1" })
  assert.equal(turn.workspaceFolderId, chatId)
  await api.bindTurn!(
    { db },
    {
      chatId: branch.chatId,
      messageId: turn.assistantMessageId,
      providerSessionId: "session_b",
      providerTurnId: "turn_b1",
    }
  )
  assert.equal((await db.get(branch.chatId))?.forkSource, undefined)
})

test("a handed-off chat continues on its saved provider despite different global defaults", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId, ids } = seedChat(
    db,
    {
      status: "failed",
      lastErrorReason: "usage-limit",
      providerId: "codex",
      providerSessionId: "old_session",
      providerModel: "gpt-6",
      providerEffort: "xhigh",
    },
    [{ request: "Explain heaps", reply: "A heap", turnId: "turn_1" }]
  )
  await db.patch(ids[1]!, { status: "failed" })
  await api.handOff!({ db }, { chatId, messageId: ids[1], providerId: "claude-code" })
  const configured = { providerId: "codex" as const, model: "gpt-6", effort: "xhigh" as const }
  // The route used to send these global defaults after every handoff.
  await assert.rejects(api.startTurn!({ db }, {
    chatId,
    clientMessageId: "wrong-provider",
    message: "",
    continuationOf: ids[1],
    attachments: [],
    providerId: configured.providerId,
    providerModel: configured.model,
    providerEffort: configured.effort,
  }), /Start a new chat to change its provider/)
  const saved = (await api.replySelection!({ db }, { chatId })) as {
    providerId: string
    providerModel: null
    providerEffort: null
  }
  const selection = savedChatReplySelection(configured, saved)
  assert.deepEqual(selection, { providerId: "claude-code", model: "default", effort: undefined })
  const resumed = (await api.startTurn!({ db }, {
    chatId,
    clientMessageId: "continue",
    message: "",
    continuationOf: ids[1],
    attachments: [],
    providerId: selection.providerId,
    providerModel: selection.model,
    providerEffort: selection.effort,
  })) as { providerId: string; providerModel: string; providerEffort?: string; providerHandoff: unknown }
  assert.equal(resumed.providerId, "claude-code")
  assert.equal(resumed.providerModel, "default")
  assert.equal(resumed.providerEffort, undefined)
  assert.deepEqual(resumed.providerHandoff, { fromProviderId: "codex", fromSessionId: "old_session" })
  await db.patch(chatId, { status: "idle" })
  const next = (await api.startTurn!({ db }, {
    chatId,
    clientMessageId: "followup",
    message: "Give an example",
    attachments: [],
    providerId: selection.providerId,
    providerModel: selection.model,
  })) as { providerId: string }
  assert.equal(next.providerId, "claude-code")
})

test("saved model choices survive global changes and new chats still use the global selection", () => {
  const configured = { providerId: "codex" as const, model: "gpt-6", effort: "high" as const }
  assert.deepEqual(savedChatReplySelection(configured), configured)
  assert.deepEqual(savedChatReplySelection(configured, { providerId: null }), configured)
  assert.deepEqual(savedChatReplySelection(configured, {
    providerId: "claude-code", providerModel: "sonnet", providerEffort: "medium",
  }), { providerId: "claude-code", model: "sonnet", effort: "medium" })
  assert.deepEqual(savedChatReplySelection(configured, { providerId: "codex" }), configured)
})

test("branches replay instead where a copy would not resume", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  // Claude Code keeps sessions per folder, and a working project's folder is not the branch's.
  const project = seedChat(
    db,
    { providerId: "claude-code", providerSessionId: "s", workingProjectId: "projects_x" },
    [{ request: "One", reply: "First", turnId: "turn_1" }]
  )
  const fromProject = (await api.branch!(
    { db },
    { chatId: project.chatId, messageId: project.ids[1], includeMessage: true }
  )) as { chatId: string }
  assert.equal((await db.get(fromProject.chatId))?.forkSource, undefined)
  // Codex resumes a copied thread from any folder.
  const codex = seedChat(
    db,
    { providerId: "codex", providerSessionId: "t", workingProjectId: "projects_x" },
    [{ request: "One", reply: "First", turnId: "turn_1" }]
  )
  const fromCodex = (await api.branch!(
    { db },
    { chatId: codex.chatId, messageId: codex.ids[1], includeMessage: true }
  )) as { chatId: string }
  assert.ok((await db.get(fromCodex.chatId))?.forkSource)
  // OpenCode has no fork; editing the first request has nothing to copy.
  const opencode = seedChat(db, { providerId: "opencode", providerSessionId: "u" }, [
    { request: "One", reply: "First", turnId: "turn_1" },
  ])
  const fromOpenCode = (await api.branch!(
    { db },
    { chatId: opencode.chatId, messageId: opencode.ids[1], includeMessage: true }
  )) as { chatId: string }
  assert.equal((await db.get(fromOpenCode.chatId))?.forkSource, undefined)
  const firstEdit = (await api.branch!(
    { db },
    { chatId: codex.chatId, messageId: codex.ids[0], includeMessage: false, editedMessage: "Zero" }
  )) as { chatId: string }
  assert.equal((await db.get(firstEdit.chatId))?.forkSource, undefined)
})

test("a redo resends the replaced request and removes the pair once rewound", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId, ids } = seedChat(
    db,
    { purpose: "teach", providerId: "codex", providerSessionId: "thread_a" },
    [
      { request: "Teach me this unit.", reply: "Outline", turnId: "turn_1" },
      { request: "Next section", reply: "```section\ns1\n```\nDijkstra", turnId: "turn_2" },
    ]
  )
  // Only the latest finished reply can be redone.
  await assert.rejects(
    api.startTurn!(
      { db },
      { chatId, clientMessageId: "r0", message: "", attachments: [], redoOf: ids[1], redoStyle: "simpler" }
    ),
    /latest finished reply/
  )
  const turn = (await api.startTurn!(
    { db },
    { chatId, clientMessageId: "r1", message: "", attachments: [], redoOf: ids[3], redoStyle: "simpler" }
  )) as {
    assistantMessageId: string
    redo: { beforeTurnId: string; replacedMessageIds: string[]; originalMessage: string }
  }
  assert.deepEqual(turn.redo, {
    beforeTurnId: "turn_2",
    replacedMessageIds: [ids[2], ids[3]],
    originalMessage: "Next section",
  })
  const request = db.rows.find(
    (row) => row.clientMessageId === "r1" && row.role === "user"
  )
  assert.equal(request?.content, "Next section")
  assert.equal((await db.get(turn.assistantMessageId))?.redoStyle, "simpler")
  await api.dropReplacedMessages!(
    { db },
    { chatId, activeMessageId: turn.assistantMessageId, messageIds: turn.redo.replacedMessageIds }
  )
  assert.equal(await db.get(ids[2]!), null)
  assert.equal(await db.get(ids[3]!), null)
  assert.ok(await db.get(ids[1]!))
})

test("a full Teach session compacts first, but never two turns running", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId, ids } = seedChat(
    db,
    {
      purpose: "teach",
      providerId: "claude-code",
      providerSessionId: "session_a",
      contextUsage: { usedTokens: 170_000, maxTokens: 200_000, percent: 85, updatedAt: 1 },
    },
    [{ request: "Next section", reply: "Section", turnId: "turn_1" }]
  )
  const first = (await api.startTurn!(
    { db },
    { chatId, clientMessageId: "a", message: "Next section", attachments: [] }
  )) as { context: { compactFirst: boolean; restate: boolean }; assistantMessageId: string }
  assert.deepEqual(first.context, { compactFirst: true, restate: true })
  // The turn compacted and restated; the next one does not compact again.
  await api.recordCompaction!(
    { db },
    { chatId, messageId: first.assistantMessageId, origin: "auto" }
  )
  await api.finishTurnContext!(
    { db },
    {
      chatId,
      messageId: first.assistantMessageId,
      usage: { usedTokens: 170_000, maxTokens: 200_000, percent: 85, updatedAt: 2 },
      restated: true,
    }
  )
  await db.patch(chatId, { status: "idle", activeMessageId: undefined })
  await db.patch(first.assistantMessageId, { status: "completed", providerTurnId: "turn_2" })
  const second = (await api.startTurn!(
    { db },
    { chatId, clientMessageId: "b", message: "Next section", attachments: [] }
  )) as { context: { compactFirst: boolean; restate: boolean } }
  assert.deepEqual(second.context, { compactFirst: false, restate: false })
  const chat = await db.get(chatId)
  assert.equal((chat?.contextCompactions as unknown[]).length, 1)
  assert.equal(chat?.contextRestatePending, false)
  assert.ok(ids.length)
})

test("Compact now holds the session, then marks the next turn to restate", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId } = seedChat(
    db,
    {
      purpose: "teach",
      projectId: "projects_1",
      providerId: "codex",
      providerSessionId: "thread_a",
      contextUsage: { usedTokens: 100_000, maxTokens: 272_000, percent: 36.8, updatedAt: 1 },
    },
    [{ request: "Next section", reply: "Section", turnId: "turn_1" }]
  )
  const session = (await api.beginCompaction!({ db }, { chatId })) as { providerSessionId: string }
  assert.equal(session.providerSessionId, "thread_a")
  await assert.rejects(api.beginCompaction!({ db }, { chatId }), /already compacting/)
  await assert.rejects(
    api.startTurn!({ db }, { chatId, clientMessageId: "x", message: "Hi", attachments: [] }),
    /compacting this session/
  )
  await api.endCompaction!(
    { db },
    { chatId, compacted: true, usage: { usedTokens: 20_000, maxTokens: 272_000, percent: 7.4, updatedAt: 2 } }
  )
  const chat = await db.get(chatId)
  assert.equal(chat?.compactingSince, undefined)
  assert.deepEqual(
    (chat?.contextCompactions as Array<{ origin: string; fromPercent: number }>).map(
      ({ origin, fromPercent }) => ({ origin, fromPercent })
    ),
    [{ origin: "manual", fromPercent: 36.8 }]
  )
  const next = (await api.startTurn!(
    { db },
    { chatId, clientMessageId: "y", message: "Next section", attachments: [] }
  )) as { context: { compactFirst: boolean; restate: boolean } }
  assert.deepEqual(next.context, { compactFirst: false, restate: true })
  // OpenCode sessions cannot be compacted.
  const other = seedChat(
    db,
    { purpose: "teach", projectId: "projects_1", providerId: "opencode", providerSessionId: "s" },
    []
  )
  await assert.rejects(api.beginCompaction!({ db }, { chatId: other.chatId }), /can't be compacted/)
})

test("notices are saved once each on the reply they explain", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { chatId, ids } = seedChat(db, {}, [{ request: "Check the page", reply: "Partial" }])
  const notice = { kind: "permission-denied", message: "WebFetch was not allowed." }
  await api.addNotice!({ db }, { chatId, messageId: ids[1], notice })
  await api.addNotice!({ db }, { chatId, messageId: ids[1], notice })
  assert.deepEqual((await db.get(ids[1]!))?.notices, [notice])
})
