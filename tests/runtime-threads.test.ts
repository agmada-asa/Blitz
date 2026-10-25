/**
 * Verifies runtime thread tidying: Convex queues a rename when a chat gets a
 * new thread or a new title and a deletion when the chat is deleted, and the
 * worker step carries the jobs out on the right engine and folder. No runtime
 * process or Convex deployment is used.
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Engine } from "agent-engines"

import {
  runRuntimeThreadStep,
  type RuntimeThreadJob,
} from "../lib/server/runtime-threads.ts"

type Row = { _id: string; _table: string; [key: string]: unknown }
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Equality filters collected from a `withIndex` callback. */
class IndexFilter {
  readonly filters: Array<[string, unknown]> = []

  /** Adds one equality filter. */
  eq(field: string, value: unknown): IndexFilter {
    this.filters.push([field, value])
    return this
  }
}

/** Minimal in-memory database for the chat and job handlers under test. */
class MemoryDb {
  rows: Row[] = []
  private next = 0

  /** Inserts a document and returns its test ID. */
  async insert(
    table: string,
    fields: Record<string, unknown>
  ): Promise<string> {
    const id = `${table}:${this.next++}`
    this.rows.push({ _id: id, _table: table, ...fields })
    return id
  }

  /** Reads a copy of one document, as Convex does, so later patches do not change it. */
  async get(id: string): Promise<Row | null> {
    const row = this.rows.find((candidate) => candidate._id === id)
    return row ? { ...row } : null
  }

  /** Applies a patch, removing fields assigned undefined. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const row = this.rows.find((candidate) => candidate._id === id)
    if (!row) throw new Error("missing row")
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete row[key]
      else row[key] = value
    }
  }

  /** Deletes one document. */
  async delete(id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row._id !== id)
  }

  /** Rows of one table, as an indexed query would return them. */
  query(table: string) {
    let rows = this.rows.filter((row) => row._table === table)
    const result = {
      withIndex: (
        _name: string,
        build?: (index: IndexFilter) => IndexFilter
      ) => {
        const filter = build ? build(new IndexFilter()) : new IndexFilter()
        rows = rows
          .filter((row) =>
            filter.filters.every(([field, value]) => row[field] === value)
          )
          .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
        return result
      },
      take: async (count: number) => rows.slice(0, count),
      collect: async () => rows,
      first: async () => rows[0] ?? null,
      unique: async () => rows[0] ?? null,
    }
    return result
  }

  /** Queued runtime thread jobs, oldest first. */
  jobs(): Row[] {
    return this.rows.filter((row) => row._table === "runtimeThreadJobs")
  }
}

/** Loads the chat handlers, resolving the extensionless imports Convex uses. */
async function loadHandlers(): Promise<Record<string, Handler>> {
  type ResolveContext = { conditions: string[]; parentURL?: string }
  type ResolveResult = { url: string; format?: string }
  type NextResolve = (
    specifier: string,
    context: ResolveContext
  ) => ResolveResult
  const { registerHooks } = (await import("node:module")) as unknown as {
    registerHooks: (hooks: {
      resolve: (
        specifier: string,
        context: ResolveContext,
        next: NextResolve
      ) => ResolveResult
    }) => { deregister: () => void }
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context)
      } catch (error) {
        if (
          specifier.startsWith(".") &&
          (error as { code?: string })?.code === "ERR_MODULE_NOT_FOUND"
        )
          for (const suffix of [".js", ".ts"]) {
            try {
              return next(specifier + suffix, context)
            } catch {
              /* Try the next local extension. */
            }
          }
        throw error
      }
    },
  })
  try {
    const loaded =
      (await import("../convex/workspaceChats.ts")) as unknown as Record<
        string,
        { _handler?: Handler }
      >
    return Object.fromEntries(
      Object.entries(loaded)
        .filter(([, value]) => typeof value?._handler === "function")
        .map(([name, value]) => [name, value._handler!])
    )
  } finally {
    hooks.deregister()
  }
}

/** Seeds a chat with an active assistant message, ready to bind a turn. */
async function seedChat(db: MemoryDb, fields: Record<string, unknown> = {}) {
  const chatId = await db.insert("workspaceChats", {
    title: "Quiz me on pointers",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  })
  const messageId = await db.insert("workspaceChatMessages", {
    chatId,
    createdAt: 2,
  })
  await db.patch(chatId, { activeMessageId: messageId })
  return { chatId, messageId }
}

test("a new thread, a generated title and a manual rename each queue one rename", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const projectId = await db.insert("projects", {})
  const { chatId, messageId } = await seedChat(db, {
    workingProjectId: projectId,
  })
  await handlers.bindTurn(
    { db },
    {
      chatId,
      messageId,
      providerId: "claude-code",
      providerSessionId: "sess-1",
      providerTurnId: "t1",
    }
  )
  assert.deepEqual(
    db
      .jobs()
      .map(({ kind, providerId, threadId, title, projectId: folder }) => ({
        kind,
        providerId,
        threadId,
        title,
        folder,
      })),
    [
      {
        kind: "rename",
        providerId: "claude-code",
        threadId: "sess-1",
        title: "Quiz me on pointers",
        folder: projectId,
      },
    ]
  )
  // Binding the same thread again (a resumed turn) queues nothing new.
  await handlers.bindTurn(
    { db },
    {
      chatId,
      messageId,
      providerId: "claude-code",
      providerSessionId: "sess-1",
      providerTurnId: "t2",
    }
  )
  assert.equal(db.jobs().length, 1)
  await handlers.setGeneratedTitle(
    { db },
    {
      chatId,
      title: "Pointers and malloc",
      expectedCurrentTitle: "Quiz me on pointers",
    }
  )
  await handlers.rename({ db }, { chatId, title: "C pointers" })
  // A newer title replaces the queued one.
  assert.deepEqual(
    db.jobs().map((job) => job.title),
    ["C pointers"]
  )
})

test("deleting a chat queues its thread's deletion and drops pending renames", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const { chatId, messageId } = await seedChat(db)
  await handlers.bindTurn(
    { db },
    {
      chatId,
      messageId,
      providerId: "codex",
      providerSessionId: "thr-9",
      providerTurnId: "t1",
    }
  )
  await handlers.remove({ db }, { chatId })
  assert.deepEqual(
    db
      .jobs()
      .map(({ kind, providerId, threadId }) => ({
        kind,
        providerId,
        threadId,
      })),
    [{ kind: "delete", providerId: "codex", threadId: "thr-9" }]
  )
  assert.equal(await db.get(chatId), null)
})

test("chats without a Codex or Claude Code thread queue nothing", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const fresh = await seedChat(db)
  await handlers.rename({ db }, { chatId: fresh.chatId, title: "Renamed" })
  await handlers.remove({ db }, { chatId: fresh.chatId })
  const opencode = await seedChat(db, {
    providerId: "opencode",
    providerSessionId: "ses_1",
  })
  await handlers.remove({ db }, { chatId: opencode.chatId })
  assert.equal(db.jobs().length, 0)
})

test("a failed job is retried at the back of the queue, then dropped", async () => {
  const handlers = await loadHandlers()
  const db = new MemoryDb()
  const jobId = await db.insert("runtimeThreadJobs", {
    kind: "delete",
    providerId: "codex",
    threadId: "thr-1",
    attempts: 0,
    createdAt: 1,
  })
  await handlers.finishRuntimeThreadJob({ db }, { jobId, failed: true })
  assert.equal((await db.get(jobId))?.attempts, 1)
  assert.ok(Number((await db.get(jobId))?.createdAt) > 1)
  await handlers.finishRuntimeThreadJob({ db }, { jobId, failed: true })
  await handlers.finishRuntimeThreadJob({ db }, { jobId, failed: true })
  assert.equal(await db.get(jobId), null)
  const done = await db.insert("runtimeThreadJobs", {
    kind: "delete",
    providerId: "codex",
    threadId: "thr-2",
    attempts: 0,
    createdAt: 2,
  })
  await handlers.finishRuntimeThreadJob({ db }, { jobId: done })
  assert.equal(await db.get(done), null)
})

/** An engine that records rename and delete calls; deleting `failId` fails. */
function fakeEngine(
  provider: string,
  calls: string[],
  failId?: string
): Engine {
  return {
    renameThread: async (
      id: string,
      title: string,
      { cwd }: { cwd: string }
    ) => {
      calls.push(`${provider} rename ${id} "${title}" in ${cwd}`)
    },
    deleteThread: async (id: string) => {
      if (id === failId) throw new Error("runtime down")
      calls.push(`${provider} delete ${id}`)
    },
    close: async () => {
      calls.push(`${provider} close`)
    },
  } as unknown as Engine
}

test("the worker step renames in the thread's folder, deletes, reports failures, and closes engines", async () => {
  const calls: string[] = []
  const finished: Array<[string, boolean]> = []
  let jobs: RuntimeThreadJob[] = [
    {
      jobId: "a",
      kind: "rename",
      providerId: "claude-code",
      threadId: "s1",
      chatId: "c1",
      title: "Teach: Week 6",
      projectId: "p1",
    },
    {
      jobId: "b",
      kind: "rename",
      providerId: "codex",
      threadId: "t1",
      chatId: "c2",
      title: "Heap sort",
    },
    { jobId: "c", kind: "delete", providerId: "codex", threadId: "t2" },
    { jobId: "d", kind: "delete", providerId: "claude-code", threadId: "s2" },
  ]
  const queue = {
    next: async () => {
      const batch = jobs
      jobs = []
      return batch
    },
    finish: async (jobId: string, failed: boolean) => {
      finished.push([jobId, failed])
    },
  }
  const folders = {
    project: (id: string) => `/projects/${id}`,
    chat: (id: string) => `/chats/${id}`,
  }
  const busy = await runRuntimeThreadStep(queue, folders, (provider) =>
    fakeEngine(provider, calls, "s2")
  )
  assert.ok(busy < 30_000)
  assert.deepEqual(calls.slice(0, 3), [
    'claude-code rename s1 "Teach: Week 6" in /projects/p1',
    'codex rename t1 "Heap sort" in /chats/c2',
    "codex delete t2",
  ])
  assert.deepEqual(finished, [
    ["a", false],
    ["b", false],
    ["c", false],
    ["d", true],
  ])
  // One engine per provider, each closed once.
  assert.deepEqual(calls.filter((call) => call.endsWith("close")).sort(), [
    "claude-code close",
    "codex close",
  ])
  // An empty queue waits longer.
  assert.equal(
    await runRuntimeThreadStep(queue, folders, () => fakeEngine("x", calls)),
    30_000
  )
})
