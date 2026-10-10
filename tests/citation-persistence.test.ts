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
      createDocument: citations.createDocument._handler,
      prepare: citations.prepare._handler,
      read: citations.read._handler,
      branch: chats.branch._handler,
      start: chats.startTurn._handler,
    }
  } finally {
    hook.deregister()
  }
}

test("chat document metadata accepts originals above the former 50 MB cap", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Study project" })
  const documentId = await api.createDocument(
    { db },
    {
      projectId,
      filename: "data.xlsx",
      relativeKey: `Sources/${"a".repeat(64)}-data.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: "[Attached file: data.xlsx]",
      sizeBytes: 50_000_001,
    }
  )
  assert.ok(await db.get(String(documentId)))
})

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
  const branchAttachment = db.rows.find(
    (row) =>
      row.table === "workspaceChatAttachments" && row.chatId === branch.chatId
  )
  assert.ok(branchAttachment?.documentId)
  assert.notEqual(branchAttachment?.documentId, documentId)
  assert.equal(
    (await db.get(String(branchAttachment?.documentId)))?.mimeType,
    "application/pdf"
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

test("reference book passages past the stored excerpt are citable at their page", async () => {
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
  // The source row keeps only the start of the book; chunks hold the rest.
  const sourceId = db.seed("sources", {
    projectId,
    filename: "textbook.pdf",
    extractedText: "[Page 1]\nPreface.",
    kind: "pdf",
    relativeKey: "Sources/book.pdf",
    mimeType: "application/pdf",
  })
  const chunkText = "Dijkstra's algorithm finds shortest paths.\n[Page 413]\nIt needs non-negative weights."
  const chunkId = db.seed("sourceChunks", {
    projectId,
    sourceId,
    ordinal: 900,
    text: chunkText,
    startOffset: 2_000_000,
    endOffset: 2_000_000 + chunkText.length,
    references: [
      { kind: "page", label: "[Page 412]", value: "412", startOffset: 1_999_000, endOffset: 2_000_043 },
      { kind: "page", label: "[Page 413]", value: "413", startOffset: 2_000_043, endOffset: 2_000_200 },
    ],
  })
  const citations = (await api.prepare(
    { db },
    { chatId, messageId, question: "Dijkstra", chunkIds: [chunkId] }
  )) as Array<{ id: string; page: number; label: string; chunkId: string }>
  assert.deepEqual(
    citations.map((citation) => [citation.label, citation.page]),
    [
      ["Page 412", 412],
      ["Page 413", 413],
    ]
  )
  assert.ok(citations.every((citation) => citation.chunkId === chunkId))
  const read = (await api.read(
    { db },
    { chatId, messageId, citationId: citations[1].id }
  )) as {
    text: string
    startOffset: number
    endOffset: number
    snapshotOnly: boolean
    fileUrl: string
  }
  // The reader shows the surrounding section with the passage highlighted.
  assert.equal(read.text, chunkText)
  assert.equal(
    read.text.slice(read.startOffset, read.endOffset),
    "[Page 413]\nIt needs non-negative weights."
  )
  assert.equal(read.snapshotOnly, false)
  assert.match(read.fileUrl, /sourceId=/)
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
    /File does not belong to this chat/
  )
})

test("submission binds an owned projectless draft to its new chat", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const documentId = db.seed("chatDocuments", {
    ownerToken: "a".repeat(32),
    text: "Draft text",
    filename: "draft.txt",
    mimeType: "image/png",
  })
  const result = (await api.start(
    { db },
    {
      clientMessageId: "owned-draft",
      message: "Read this",
      attachments: [
        {
          kind: "file",
          label: "draft.txt",
          documentId,
          ownerToken: "a".repeat(32),
        },
      ],
    }
  )) as { chatId: string }
  assert.equal((await db.get(documentId))?.chatId, result.chatId)
  const savedAttachment = db.rows.find(
    (row) => row.table === "workspaceChatAttachments" && row.chatId === result.chatId
  )
  assert.equal(savedAttachment?.text, "Draft text")
  assert.equal(savedAttachment?.mimeType, "image/png")
})

test("submission binds an owned projectless draft to an existing projectless chat", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Existing",
    status: "idle",
  })
  const documentId = db.seed("chatDocuments", {
    ownerToken: "b".repeat(32),
    text: "Draft text",
    filename: "draft.txt",
  })
  await api.start(
    { db },
    {
      chatId,
      clientMessageId: "owned-existing-draft",
      message: "Read this",
      attachments: [
        {
          kind: "file",
          label: "draft.txt",
          documentId,
          ownerToken: "b".repeat(32),
          text: "Draft text",
        },
      ],
    }
  )
  assert.equal((await db.get(documentId))?.chatId, chatId)
})

test("continuation replays before provider acceptance and resumes after acceptance", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const chatId = db.seed("workspaceChats", {
    title: "Retry",
    status: "failed",
    providerSessionId: "session-old",
    codexThreadId: "thread-old",
    codexContextReady: true,
  })
  const userId = db.seed("workspaceChatMessages", {
    chatId,
    role: "user",
    status: "completed",
    content: "Describe the image",
    clientMessageId: "original",
    createdAt: 1,
  })
  void userId
  const failedId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "failed",
    content: "",
    clientMessageId: "original",
    createdAt: 2,
  })
  await db.patch(chatId, { activeMessageId: failedId })
  const fresh = (await api.start(
    { db },
    {
      chatId,
      continuationOf: failedId,
      clientMessageId: "retry-before-accept",
      message: "",
      attachments: [],
    }
  )) as { providerSessionId: string | null; shouldReplayContext: boolean }
  assert.equal(fresh.providerSessionId, null)
  assert.equal(fresh.shouldReplayContext, true)

  const acceptedId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "failed",
    content: "Partial answer",
    providerTurnId: "turn-accepted",
    clientMessageId: "accepted",
    createdAt: 3,
  })
  await db.patch(chatId, { activeMessageId: acceptedId, status: "failed" })
  const resumed = (await api.start(
    { db },
    {
      chatId,
      continuationOf: acceptedId,
      clientMessageId: "retry-after-accept",
      message: "",
      attachments: [],
    }
  )) as { providerSessionId: string | null; replyPrefix: string }
  assert.equal(resumed.providerSessionId, "session-old")
  assert.equal(resumed.replyPrefix, "Partial answer")
})
