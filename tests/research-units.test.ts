/**
 * Exercises approved research imports with the real Convex handlers and an
 * in-memory database: sources land in the picked unit or one new unit per
 * research request, carry their passages, and are citable straight away.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { prepareTextSource } from "../lib/server/source-ingestion/chunk-rows.ts"
import { researchUnitTitle } from "../lib/research-unit.ts"

/** Minimal document representation used by the handler test double. */
type Row = { _id: string; table: string; [key: string]: unknown }
/** Handler interface keeps untrusted test arguments explicit. */
type Handler = (
  ctx: { db: MemoryDb },
  args: Record<string, unknown>
) => Promise<unknown>

/** Implements the indexed reads and writes used by research and citation handlers. */
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
  /** Applies a patch; `undefined` values clear fields as in Convex. */
  async patch(id: string, data: Record<string, unknown>) {
    const row = (await this.get(id))!
    for (const [key, value] of Object.entries(data))
      if (value === undefined) delete row[key]
      else row[key] = value
  }
  /** Inserts a document through the same implementation as fixtures. */
  async insert(table: string, data: Record<string, unknown>) {
    return this.seed(table, data)
  }
  /** Lists rows in one table. */
  table(table: string) {
    return this.rows.filter((row) => row.table === table)
  }
  /** Supports chained equality filters, ordering by `order` or `createdAt`, and bounded reads. */
  query(table: string) {
    const filters: Array<[string, unknown]> = []
    let direction = 1
    const index = {
      eq: (field: string, value: unknown) => {
        filters.push([field, value])
        return index
      },
    }
    const read = () =>
      this.rows
        .filter(
          (row) =>
            row.table === table &&
            filters.every(([field, value]) => row[field] === value)
        )
        .sort(
          (a, b) =>
            direction *
            (Number(a.order ?? a.createdAt ?? 0) -
              Number(b.order ?? b.createdAt ?? 0))
        )
    const chain = {
      withIndex: (_name: string, callback?: (q: typeof index) => unknown) => {
        callback?.(index)
        return chain
      },
      order: (order: string) => {
        direction = order === "desc" ? -1 : 1
        return chain
      },
      take: async (limit: number) => read().slice(0, limit),
      first: async (): Promise<Row | null> => read()[0] ?? null,
      unique: async (): Promise<Row | null> => read()[0] ?? null,
      collect: async () => read(),
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
    const research = (await import("../convex/research.ts")) as unknown as Record<
      string,
      { _handler: Handler }
    >
    const citations =
      (await import("../convex/chatCitations.ts")) as unknown as Record<
        string,
        { _handler: Handler }
      >
    return {
      apply: research.apply._handler,
      completeImport: research.completeImport._handler,
      prepare: citations.prepare._handler,
    }
  } finally {
    hook.deregister()
  }
}

/** Seeds a project with one unit and a ready proposal of three sources. */
function seedProposal(db: MemoryDb) {
  const projectId = db.seed("projects", { title: "COMP26120" })
  const existingUnitId = db.seed("units", {
    projectId,
    title: "Week 1",
    titleSource: "user",
    order: 1,
  })
  const proposalId = db.seed("researchProposals", {
    projectId,
    requestId: "request-1",
    request: "Help me learn graph algorithms.",
    status: "ready",
    scope: "Shortest paths",
    topics: ["graphs"],
    sources: [0, 1, 2].map((index) => ({
      url: `https://example.edu/${index}.pdf`,
      title: `Notes ${index}`,
      reason: "Covers the topic.",
      verification: "suggested-unverified",
    })),
    generatedNotes: [],
    createdAt: 1,
    updatedAt: 1,
  })
  return { projectId, existingUnitId, proposalId }
}

/** Leases one queued import the way `claimNextImport` would. */
async function lease(db: MemoryDb, sourceIndex: number) {
  const row = db
    .table("researchProposalImports")
    .find((item) => item.sourceIndex === sourceIndex)!
  await db.patch(row._id, {
    status: "running",
    leaseToken: `lease-${sourceIndex}`,
    leaseExpiresAt: Date.now() + 60_000,
  })
  return row._id
}

/** Completes one leased import with worker-prepared passages. */
async function complete(
  api: Awaited<ReturnType<typeof handlers>>,
  db: MemoryDb,
  sourceIndex: number,
  text: string
) {
  const importId = await lease(db, sourceIndex)
  const prepared = prepareTextSource({
    seed: `research:${importId}:1`,
    filename: `Notes ${sourceIndex}.pdf`,
    kind: "pdf",
    text,
  })
  return (await api.completeImport(
    { db },
    {
      importId,
      leaseToken: `lease-${sourceIndex}`,
      filename: `Notes ${sourceIndex}.pdf`,
      kind: "pdf",
      extractedText: prepared.text,
      chunks: prepared.chunks,
      originalUrl: `https://example.edu/${sourceIndex}.pdf`,
    }
  )) as { sourceId: string; unitId: string }
}

test("research unit titles name the topic, not the request", () => {
  assert.equal(
    researchUnitTitle("Help me learn graph algorithms."),
    "Graph algorithms"
  )
  assert.equal(researchUnitTitle("I want to understand B-trees"), "B-trees")
  assert.equal(researchUnitTitle("Learning theory"), "Learning theory")
  assert.equal(researchUnitTitle("teach me", ["dynamic programming"]), "Dynamic programming")
  assert.equal(researchUnitTitle("   ", []), "Research")
  assert.ok(researchUnitTitle("word ".repeat(40)).length <= 80)
})

test("approved imports share a new unit, carry passages, and are citable at once", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { projectId, proposalId } = seedProposal(db)
  await api.apply(
    { db },
    { projectId, requestId: "request-1", sourceIndexes: [0, 1] }
  )
  const first = await complete(
    api,
    db,
    0,
    "[Page 1]\nDijkstra's algorithm finds shortest paths.\n\n[Page 2]\nIt needs non-negative weights."
  )
  const second = await complete(api, db, 1, "# Bellman-Ford\nHandles negative edges.")

  // One new unit for the research, at the end of the path, retitled by the tutor later.
  assert.equal(first.unitId, second.unitId)
  const unit = await db.get(first.unitId)
  assert.equal(unit?.title, "Graph algorithms")
  assert.equal(unit?.titleSource, "auto")
  assert.equal(unit?.order, 2)
  assert.equal((await db.get(proposalId))?.unitId, first.unitId)
  assert.equal((await db.get(first.sourceId))?.unitId, first.unitId)
  for (const row of db.table("researchProposalImports"))
    assert.equal(row.unitId, first.unitId)

  // Passages are exact slices of the stored text.
  const source = (await db.get(first.sourceId))!
  const chunks = db
    .table("sourceChunks")
    .filter((chunk) => chunk.sourceId === first.sourceId)
  assert.ok(chunks.length > 0)
  for (const chunk of chunks)
    assert.equal(
      String(source.extractedText).slice(
        Number(chunk.startOffset),
        Number(chunk.endOffset)
      ),
      chunk.text
    )

  // A Teach turn citing these chunks gets page-anchored passages.
  const chatId = db.seed("workspaceChats", { projectId, status: "running" })
  const messageId = db.seed("workspaceChatMessages", {
    chatId,
    role: "assistant",
    status: "running",
    content: "",
  })
  await db.patch(chatId, { activeMessageId: messageId })
  const citations = (await api.prepare(
    { db },
    {
      chatId,
      messageId,
      question: "negative weights",
      chunkIds: chunks.map((chunk) => chunk._id),
    }
  )) as Array<{ label: string; page?: number; sourceId: string }>
  assert.deepEqual(
    citations.map((citation) => [citation.label, citation.page]).sort(),
    [
      ["Page 1", 1],
      ["Page 2", 2],
    ]
  )
})

test("imports go into a picked unit, and foreign units or mismatched passages are refused", async () => {
  const api = await handlers()
  const db = new MemoryDb()
  const { projectId, existingUnitId } = seedProposal(db)
  const otherProject = db.seed("projects", { title: "Other" })
  const foreignUnit = db.seed("units", { projectId: otherProject, title: "X", order: 1 })
  await assert.rejects(
    api.apply(
      { db },
      { projectId, requestId: "request-1", sourceIndexes: [2], unitId: foreignUnit }
    ),
    /Unit was not found/
  )
  await api.apply(
    { db },
    { projectId, requestId: "request-1", sourceIndexes: [2], unitId: existingUnitId }
  )
  const importId = await lease(db, 2)
  await assert.rejects(
    api.completeImport(
      { db },
      {
        importId,
        leaseToken: "lease-2",
        filename: "Notes 2.pdf",
        kind: "pdf",
        extractedText: "Heaps keep the minimum on top.",
        chunks: [
          {
            ordinal: 0,
            text: "Different text",
            textHash: "abcdef12",
            startOffset: 0,
            endOffset: 14,
            references: [],
          },
        ],
        originalUrl: "https://example.edu/2.pdf",
      }
    ),
    /passages do not match/
  )
  const result = await complete(api, db, 2, "Heaps keep the minimum on top.")
  assert.equal(result.unitId, existingUnitId)
  assert.equal(db.table("units").length, 2)
})
