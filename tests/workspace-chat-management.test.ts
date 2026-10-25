/** Verifies workspace chat archiving, cascading deletion, failure records, and active/archived queries. */

import assert from "node:assert/strict"
import test from "node:test"

type Row = { _id: string; table: string; [key: string]: unknown }
type Handler<TArgs = Record<string, unknown>, TReturn = unknown> = (
  ctx: { db: MemoryDb },
  args: TArgs
) => Promise<TReturn>

/** In-memory database supporting the workspace chat queries and mutations under test. */
class MemoryDb {
  rows: Row[] = []
  deleted: string[] = []

  /** Seeds a document and returns its deterministic test ID. */
  seed(table: string, fields: Record<string, unknown>): string {
    const id = `${table}:${this.rows.length}`
    this.rows.push({ _id: id, table, ...fields })
    return id
  }

  /** Reads one document by ID. */
  async get(id: string): Promise<Row | null> {
    return this.rows.find((row) => row._id === id) ?? null
  }

  /** Applies patches to an existing document. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const row = await this.get(id)
    if (!row) throw new Error("missing row")
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key]
      else row[key] = value
    }
  }

  /** Deletes a document by ID. */
  async delete(id: string): Promise<void> {
    this.deleted.push(id)
    this.rows = this.rows.filter((row) => row._id !== id)
  }

  /** Emulates Convex query builder for tables and indexes used in workspaceChats. */
  query(table: string) {
    return {
      withIndex: (
        _name: string,
        callback?: (q: {
          eq: (field: string, value: unknown) => void
        }) => unknown
      ) => {
        let filterField: string | null = null
        let filterValue: unknown = undefined
        if (callback) {
          callback({
            eq: (field, value) => {
              filterField = field
              filterValue = value
            },
          })
        }
        return {
          order: () => ({
            first: async () => {
              let matching = this.rows.filter((row) => row.table === table)
              if (filterField !== null) {
                matching = matching.filter((row) => row[filterField!] === filterValue)
              }
              matching.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
              return matching[0] ?? null
            },
            take: async (limit: number) => {
              let matching = this.rows.filter((row) => row.table === table)
              if (filterField !== null) {
                matching = matching.filter((row) => row[filterField!] === filterValue)
              }
              matching.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
              return matching.slice(0, limit)
            },
            collect: async () => {
              let matching = this.rows.filter((row) => row.table === table)
              if (filterField !== null) {
                matching = matching.filter((row) => row[filterField!] === filterValue)
              }
              matching.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
              return matching
            },
          }),
          take: async (limit: number) => {
            let matching = this.rows.filter((row) => row.table === table)
            if (filterField !== null) {
              matching = matching.filter((row) => row[filterField!] === filterValue)
            }
            return matching.slice(0, limit)
          },
        }
      },
    }
  }
}

/** Loads workspaceChats handlers with the repository's Node test loader pattern. */
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
              // Try next suffix.
            }
          }
        }
        throw error
      }
    },
  })
  try {
    const loaded = (await import("../convex/workspaceChats.ts")) as unknown as {
      list: { _handler: Handler }
      get: { _handler: Handler }
      setUnread: { _handler: Handler }
      setArchived: { _handler: Handler }
      remove: { _handler: Handler }
      setGeneratedTitle: { _handler: Handler }
      fail: { _handler: Handler }
      handOff: { _handler: Handler }
      bindTurn: { _handler: Handler }
    }
    return {
      list: loaded.list._handler,
      get: loaded.get._handler,
      setUnread: loaded.setUnread._handler,
      setArchived: loaded.setArchived._handler,
      remove: loaded.remove._handler,
      setGeneratedTitle: loaded.setGeneratedTitle._handler,
      fail: loaded.fail._handler,
      handOff: loaded.handOff._handler,
      bindTurn: loaded.bindTurn._handler,
    }
  } finally {
    hooks.deregister()
  }
}

test("setArchived updates archive state and unpins archived chat", async () => {
  const { setArchived } = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Acoustics research",
    isPinned: true,
    isArchived: false,
    updatedAt: 100,
  })

  // Archive the chat.
  await setArchived({ db }, { chatId, archived: true })
  const archivedChat = await db.get(chatId)
  assert.equal(archivedChat?.isArchived, true)
  assert.equal(archivedChat?.isPinned, false)
  assert.ok(typeof archivedChat?.archivedAt === "number")

  // Unarchive the chat.
  await setArchived({ db }, { chatId, archived: false })
  const unarchivedChat = await db.get(chatId)
  assert.equal(unarchivedChat?.isArchived, false)
  assert.equal(unarchivedChat?.archivedAt, undefined)

  // Non-existent chat rejects.
  await assert.rejects(
    setArchived({ db }, { chatId: "missing", archived: true }),
    /Chat not found/
  )
})

test("setUnread updates live chats and ignores deleted chat IDs", async () => {
  const { setUnread } = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Unread chat",
    isUnread: false,
  })

  // Mark a live chat unread.
  await setUnread({ db }, { chatId, unread: true })
  assert.equal((await db.get(chatId))?.isUnread, true)

  // A stale history snapshot may still reference a chat deleted elsewhere.
  await db.delete(chatId)
  await setUnread({ db }, { chatId, unread: false })
  assert.equal(await db.get(chatId), null)
})

test("remove deletes chat and its dependent messages and attachments", async () => {
  const { remove } = await loadHandlers()
  const db = new MemoryDb()
  const chat1 = db.seed("workspaceChats", { title: "Chat 1" })
  const chat2 = db.seed("workspaceChats", { title: "Chat 2" })

  const msg1 = db.seed("workspaceChatMessages", { chatId: chat1, content: "Hello 1" })
  const msg2 = db.seed("workspaceChatMessages", { chatId: chat1, content: "Hello 2" })
  const otherMsg = db.seed("workspaceChatMessages", { chatId: chat2, content: "Keep me" })

  const att1 = db.seed("workspaceChatAttachments", { chatId: chat1, label: "Source 1" })
  const otherAtt = db.seed("workspaceChatAttachments", { chatId: chat2, label: "Keep source" })

  await remove({ db }, { chatId: chat1 })

  assert.equal(await db.get(chat1), null)
  assert.equal(await db.get(msg1), null)
  assert.equal(await db.get(msg2), null)
  assert.equal(await db.get(att1), null)

  // Chat 2 and its children remain intact.
  assert.ok(await db.get(chat2))
  assert.ok(await db.get(otherMsg))
  assert.ok(await db.get(otherAtt))
})

test("list separates active and archived chats and resolves project titles", async () => {
  const { list } = await loadHandlers()
  const db = new MemoryDb()
  const proj1 = db.seed("projects", { title: "Sound Design", createdAt: 50 })
  const proj2 = db.seed("projects", { title: "ML Basics", createdAt: 60 })

  const active1 = db.seed("workspaceChats", {
    projectId: proj1,
    title: "Synths",
    isPinned: false,
    isArchived: false,
    updatedAt: 300,
  })
  const active2 = db.seed("workspaceChats", {
    projectId: proj2,
    title: "Neural nets",
    isPinned: true,
    isArchived: false,
    updatedAt: 200,
  })
  const archived1 = db.seed("workspaceChats", {
    projectId: proj1,
    title: "Old drum machines",
    isPinned: false,
    isArchived: true,
    updatedAt: 100,
  })

  // List active chats.
  const activeChats = (await list({ db }, { archived: false })) as Array<{
    id: string
    title: string
    projectTitle: string | null
    isArchived: boolean
  }>
  assert.equal(activeChats.length, 2)
  assert.ok(activeChats.some((c) => c.id === active1 && c.projectTitle === "Sound Design" && !c.isArchived))
  assert.ok(activeChats.some((c) => c.id === active2 && c.projectTitle === "ML Basics" && !c.isArchived))
  assert.ok(!activeChats.some((c) => c.id === archived1))

  // List archived chats.
  const archivedChats = (await list({ db }, { archived: true })) as Array<{
    id: string
    title: string
    projectTitle: string | null
    isArchived: boolean
  }>
  assert.equal(archivedChats.length, 1)
  assert.equal(archivedChats[0]?.id, archived1)
  assert.equal(archivedChats[0]?.title, "Old drum machines")
  assert.equal(archivedChats[0]?.projectTitle, "Sound Design")
  assert.equal(archivedChats[0]?.isArchived, true)
})

test("setGeneratedTitle updates title only if not manually renamed", async () => {
  const { setGeneratedTitle } = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Initial first line...",
    updatedAt: 100,
  })

  // Updates when expectedCurrentTitle matches
  await setGeneratedTitle(
    { db },
    {
      chatId,
      title: "Succinct AI Title",
      expectedCurrentTitle: "Initial first line...",
    }
  )
  let chat = await db.get(chatId)
  assert.equal(chat?.title, "Succinct AI Title")

  // Does not overwrite when expectedCurrentTitle does not match
  await setGeneratedTitle(
    { db },
    {
      chatId,
      title: "Another Title",
      expectedCurrentTitle: "Initial first line...",
    }
  )
  chat = await db.get(chatId)
  assert.equal(chat?.title, "Succinct AI Title")
})

test("list supports chats without an owning project", async () => {
  const { list } = await loadHandlers()
  const db = new MemoryDb()

  const standaloneChat = db.seed("workspaceChats", {
    title: "General discussion",
    isPinned: false,
    isArchived: false,
    updatedAt: 100,
  })

  const chats = (await list({ db }, { archived: false })) as Array<{
    id: string
    title: string
    projectId?: string
    projectTitle: string | null
  }>

  assert.equal(chats.length, 1)
  assert.equal(chats[0]?.id, standaloneChat)
  assert.equal(chats[0]?.title, "General discussion")
  assert.equal(chats[0]?.projectId, undefined)
  assert.equal(chats[0]?.projectTitle, null)
})

test("get returns transcript messages and attachments with clientMessageId", async () => {
  const { get } = await loadHandlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Attachment chat",
    status: "idle",
  })
  const clientMsgId = "client-msg-123"
  db.seed("workspaceChatMessages", {
    chatId,
    clientMessageId: clientMsgId,
    role: "user",
    content: "Please check this attached document",
    status: "completed",
    createdAt: 1000,
  })
  db.seed("workspaceChatAttachments", {
    chatId,
    clientMessageId: clientMsgId,
    kind: "file",
    label: "notes.pdf",
    mimeType: "application/pdf",
    createdAt: 1000,
  })

  const result = (await get({ db }, { chatId })) as {
    messages: Array<{ id: string; clientMessageId: string | null; role: string; content: string }>
    attachments: Array<{ id: string; clientMessageId: string | null; kind: string; label: string }>
  }

  assert.ok(result)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0]?.clientMessageId, clientMsgId)
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0]?.clientMessageId, clientMsgId)
  assert.equal(result.attachments[0]?.label, "notes.pdf")
})


/** Seeds a chat whose assistant reply is still running, as `fail` expects. */
function seedRunningChat(db: MemoryDb): { chatId: string; messageId: string } {
  const chatId = db.seed("workspaceChats", {
    title: "Running chat",
    status: "running",
    updatedAt: 100,
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    content: "",
    status: "running",
    createdAt: 100,
  })
  db.rows.find((row) => row._id === chatId)!.activeMessageId = messageId
  return { chatId, messageId }
}

test("fail records a normalized reason and bounded detail beside the recovery copy", async () => {
  const { fail, get } = await loadHandlers()
  const db = new MemoryDb()
  const first = seedRunningChat(db)

  // Free text in the category becomes "unknown"; long detail is truncated.
  await fail(
    { db },
    {
      ...first,
      error: "Blitz could not finish that reply. Try again.",
      reason: "Not a category!",
      detail: `  ${"x".repeat(900)}  `,
    }
  )
  const failed = (await get({ db }, { chatId: first.chatId })) as {
    status: string
    lastError: string | null
    lastErrorReason: string | null
    lastErrorDetail: string | null
  }
  assert.equal(failed.status, "failed")
  assert.equal(
    failed.lastError,
    "Blitz could not finish that reply. Try again."
  )
  assert.equal(failed.lastErrorReason, "unknown")
  assert.equal(failed.lastErrorDetail, "x".repeat(500))

  // A later failure without detail must not keep the previous detail.
  await db.patch(first.chatId, {
    status: "running",
    activeMessageId: first.messageId,
  })
  await fail(
    { db },
    { ...first, error: "That reply took too long.", reason: "timeout" }
  )
  const again = (await get({ db }, { chatId: first.chatId })) as typeof failed
  assert.equal(again.lastErrorReason, "timeout")
  assert.equal(again.lastErrorDetail, null)
})

test("handOff moves a chat stopped at a usage limit to another provider", async () => {
  const { fail, get, handOff, bindTurn } = await loadHandlers()
  const db = new MemoryDb()
  const turn = seedRunningChat(db)
  await db.patch(turn.chatId, {
    providerId: "codex",
    providerSessionId: "codex-thread",
    codexThreadId: "codex-thread",
    providerModel: "gpt-6",
    providerEffort: "xhigh",
    agentAutonomy: "project",
    workingProjectId: "project-1",
    agentPlanFirst: true,
    forkSource: { sessionId: "codex-source", throughTurnId: "codex-turn" },
  })
  const move = { ...turn, providerId: "claude-code" }

  // Only a usage limit opens the handoff.
  await fail({ db }, { ...turn, error: "Timed out", reason: "timeout" })
  await assert.rejects(handOff({ db }, move), /usage limit/)
  await db.patch(turn.chatId, { status: "running", activeMessageId: turn.messageId })
  await fail(
    { db },
    { ...turn, error: "You've reached the usage limit.", reason: "usage-limit" }
  )
  await assert.rejects(
    handOff({ db }, { ...turn, providerId: "codex" }),
    /already uses/
  )

  await handOff({ db }, move)
  const chat = (await db.get(turn.chatId))!
  assert.equal(chat.providerId, "claude-code")
  for (const field of [
    "providerSessionId",
    "codexThreadId",
    "providerModel",
    "providerEffort",
    // A pending fork names a Codex thread the new provider cannot copy.
    "forkSource",
  ])
    assert.equal(chat[field], undefined, field)
  // Agent settings stay with the chat, for whichever provider supports them.
  assert.equal(chat.agentAutonomy, "project")
  assert.equal(chat.workingProjectId, "project-1")
  assert.equal(chat.agentPlanFirst, true)
  assert.deepEqual(chat.providerHandoff, {
    fromProviderId: "codex",
    fromSessionId: "codex-thread",
  })
  const view = (await get({ db }, { chatId: turn.chatId })) as {
    messages: Array<{ continuedWith: unknown }>
  }
  assert.deepEqual(view.messages[0]!.continuedWith, {
    providerId: "claude-code",
    fromProviderId: "codex",
  })

  // The new provider's session takes the conversation over, so the handoff ends.
  await db.patch(turn.chatId, { status: "running", activeMessageId: turn.messageId })
  await bindTurn(
    { db },
    {
      ...turn,
      providerId: "claude-code",
      providerSessionId: "claude-session",
      providerTurnId: "claude-turn",
    }
  )
  assert.equal((await db.get(turn.chatId))!.providerHandoff, undefined)
})
