/** Exercises citation persistence and ownership with real Convex handlers and isolated in-memory records. */
import assert from "node:assert/strict"
import test from "node:test"

/** Minimal document representation used by the handler test double. */
type Row = { _id: string; table: string; [key: string]: unknown }
/** Handler interface keeps untrusted test arguments explicit. */
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Implements the indexed operations exercised by citation and branch mutations. */
class MemoryDb {
  rows: Row[] = []
  /** Seeds an isolated row using ID characters accepted by citation links. */
  seed(table: string, data: Record<string, unknown>) {
    const id = `${table}_${this.rows.length}`
    this.rows.push({ _id: id, table, ...data })
    return id
  }
  /** Reads a test document. */
  async get(id: string) {
    return this.rows.find((row) => row._id === id) ?? null
  }
  /** Applies a mutation without touching live data. */
  async patch(id: string, data: Record<string, unknown>) {
    Object.assign((await this.get(id))!, data)
  }
  /** Inserts a document through the same implementation as fixtures. */
  async insert(table: string, data: Record<string, unknown>) {
    return this.seed(table, data)
  }
  /** Supports chained equality filters, chronological ordering, and bounded reads. */
  query(table: string) {
    const filters: Array<[string, unknown]> = []
    let direction = 1
    const index = {
      eq: (field: string, value: unknown) => {
        filters.push([field, value])
        return index
      },
    }
    const chain = {
      first: async (): Promise<Row | null> => (await chain.take(1))[0] ?? null,
      withIndex: (_name: string, callback: (q: typeof index) => unknown) => {
        callback(index)
        return chain
      },
      order: (order: string) => {
        direction = order === "desc" ? -1 : 1
        return chain
      },
      take: async (limit: number) =>
        this.rows
          .filter(
            (row) =>
              row.table === table &&
              filters.every(([field, value]) => row[field] === value)
          )
          .sort(
            (a, b) =>
              direction * (Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
          )
          .slice(0, limit),
    }
    return chain
  }
}

/** Loads extensionless Convex imports with Node's repository-standard resolver. */
async function handlers() {
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
    const citations =
      (await import("../convex/chatCitations.ts")) as unknown as Record<
        string,
        { _handler: Handler }
      >
    const chats =
      (await import("../convex/workspaceChats.ts")) as unknown as Record<
        string,
        { _handler: Handler }
      >
    return {
      prepare: citations.prepare._handler,
      read: citations.read._handler,
      branch: chats.branch._handler,
      start: chats.startTurn._handler,
    }
  } finally {
    hook.deregister()
  }
}

test("ad hoc passages survive completion, follow-up, and branching; cross-chat reads fail", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Fixture" })
  const chatId = db.seed("workspaceChats", {
    projectId,
    title: "Fixture",
    status: "running",
  })
  const documentId = db.seed("chatDocuments", {
    projectId,
    filename: "notes.pdf",
    text: "[Page 8]\nTokens split input.\n\n[Page 26]\nHistory adds context.",
    mimeType: "application/pdf",
  })
  db.seed("workspaceChatAttachments", {
    chatId,
    documentId,
    kind: "file",
    label: "notes.pdf",
    text: "[Page 8]\nTokens split input.",
    clientMessageId: "request1",
  })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    content: "",
    status: "running",
    clientMessageId: "request1",
    createdAt: 1,
  })
  await db.patch(chatId, { activeMessageId: messageId })
  const citations = (await api.prepare(
    { db },
    { chatId, messageId, question: "Explain history on page 26", chunkIds: [] }
  )) as Array<{ id: string; page?: number }>
  assert.ok(citations.some((citation) => citation.page === 26))
  const citation = citations.find((item) => item.page === 26)!
  await db.patch(messageId, {
    content: `[Page 26](citation:${citation.id})`,
    status: "completed",
  })
  assert.equal(
    await api.read(
      { db },
      { chatId: "another", messageId, citationId: citation.id }
    ),
    null
  )
  const read = (await api.read(
    { db },
    { chatId, messageId, citationId: citation.id }
  )) as { text: string; fileUrl: string }
  assert.match(read.text, /Tokens/)
  assert.match(read.fileUrl, /documentId=/)
  await db.patch(chatId, { status: "idle" })
  const branch = (await api.branch(
    { db },
    { chatId, messageId, includeMessage: true }
  )) as { chatId: string }
  const branchedMessage = db.rows.find(
    (row) =>
      row.table === "workspaceChatMessages" && row.chatId === branch.chatId
  )!
  assert.deepEqual(
    branchedMessage.citations,
    (await db.get(messageId))?.citations
  )
  assert.ok(
    db.rows.some(
      (row) =>
        row.table === "workspaceChatAttachments" &&
        row.chatId === branch.chatId &&
        row.documentId === documentId
    )
  )
  const followup = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
    content: "",
    createdAt: 2,
  })
  await db.patch(chatId, { status: "running", activeMessageId: followup })
  const next = (await api.prepare(
    { db },
    { chatId, messageId: followup, question: "Expand on that", chunkIds: [] }
  )) as Array<{ id: string }>
  assert.ok(next.some((item) => item.id === citation.id))
})

test("project chunk references keep their page, reject other projects, and retain deleted-source snapshots", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", {})
  const chatId = db.seed("workspaceChats", { projectId, status: "running" })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
    content: "",
  })
  await db.patch(chatId, { activeMessageId: messageId })
  const sourceId = db.seed("sources", {
    projectId,
    filename: "chapter.pdf",
    extractedText: "[Page 8]\nTokens encode text.",
    kind: "pdf",
  })
  const chunkId = db.seed("sourceChunks", {
    projectId,
    sourceId,
    startOffset: 10,
    endOffset: 26,
  })
  const foreignId = db.seed("sourceChunks", {
    projectId: "foreign",
    sourceId,
    startOffset: 0,
    endOffset: 100,
  })
  const citations = (await api.prepare(
    { db },
    { chatId, messageId, question: "tokens", chunkIds: [chunkId, foreignId] }
  )) as Array<{ id: string; page: number }>
  assert.equal(citations.length, 1)
  assert.equal(citations[0].page, 8)
  db.rows = db.rows.filter((row) => row._id !== sourceId)
  const read = (await api.read(
    { db },
    { chatId, messageId, citationId: citations[0].id }
  )) as { text: string; snapshotOnly: boolean }
  assert.match(read.text, /Tokens encode text/)
  assert.equal(read.snapshotOnly, true)
})

test("submission rejects an ad hoc document from another project", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Allowed" })
  const foreignId = db.seed("projects", { title: "Other" })
  const documentId = db.seed("chatDocuments", {
    projectId: foreignId,
    text: "Other project text",
  })
  await assert.rejects(
    api.start(
      { db },
      {
        projectId,
        clientMessageId: "foreign-upload",
        message: "Read this",
        attachments: [
          {
            kind: "file",
            label: "notes.txt",
            text: "Injected text",
            documentId,
          },
        ],
      }
    ),
    /File does not belong to this chat's project/
  )
})
