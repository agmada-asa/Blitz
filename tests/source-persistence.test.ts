/** Verifies atomic source/job creation and retry deduplication at the mutation boundary. */

import assert from "node:assert/strict"
import test from "node:test"

type TableName = "projects" | "sources" | "preparationJobs"
type Row = {
  _id: string
  _creationTime: number
  [key: string]: unknown
}
type QueryCondition = { field: string; value: unknown }

/** Minimal query surface exercised by `sources.createAndEnqueue`. */
class MemoryQuery {
  private readonly rows: Row[]

  /** Creates an in-memory query over rows matching an index condition. */
  constructor(rows: Row[]) {
    this.rows = rows
  }

  /** Keeps insertion order because the mutation only needs the first match. */
  order(direction: "asc" | "desc"): this {
    void direction
    return this
  }

  /** Returns at most the requested bounded number of rows. */
  async take(limit: number): Promise<Row[]> {
    return this.rows.slice(0, limit)
  }

  /** Returns the first matching row, if any. */
  async first(): Promise<Row | null> {
    return this.rows[0] ?? null
  }
}

/** Small in-memory Convex-like database for one focused mutation regression. */
class MemoryDb {
  private readonly tables = new Map<TableName, Map<string, Row>>([
    ["projects", new Map()],
    ["sources", new Map()],
    ["preparationJobs", new Map()],
  ])
  private nextId = 1

  /** Reads one seeded or persisted row by its in-memory ID. */
  async get(id: string): Promise<Row | null> {
    for (const table of this.tables.values()) {
      const row = table.get(id)
      if (row) return row
    }
    return null
  }

  /** Inserts a row and assigns an ID shaped like a Convex document ID. */
  async insert(
    tableName: TableName,
    value: Record<string, unknown>
  ): Promise<string> {
    const id = `${tableName}:${this.nextId++}`
    this.tables.get(tableName)!.set(id, {
      ...value,
      _id: id,
      _creationTime: Date.now(),
    })
    return id
  }

  /** Patches one persisted row with the fields used by the mutation. */
  async patch(id: string, value: Record<string, unknown>): Promise<void> {
    const row = await this.get(id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }

  /** Starts an in-memory indexed query with exact equality filtering. */
  query(tableName: TableName) {
    return {
      withIndex: (
        _indexName: string,
        callback: (query: {
          eq: (field: string, value: unknown) => unknown
        }) => unknown
      ) => {
        const conditions: QueryCondition[] = []
        const queryBuilder: {
          eq: (field: string, value: unknown) => unknown
        } = {
          eq: (field: string, value: unknown) => {
            conditions.push({ field, value })
            return queryBuilder
          },
        }
        callback(queryBuilder)
        const rows = [...this.tables.get(tableName)!.values()].filter((row) =>
          conditions.every(
            (condition) => row[condition.field] === condition.value
          )
        )
        return new MemoryQuery(rows)
      },
    }
  }

  /** Counts rows in one test table without exposing database internals. */
  count(tableName: TableName): number {
    return this.tables.get(tableName)!.size
  }
}

type SourceArgs = {
  projectId: string
  filename: string
  kind: "pdf" | "markdown" | "text" | "paste"
  extractedText: string
  originalUrl?: string
}
type MutationContext = { db: MemoryDb }
type CreateAndEnqueueHandler = (
  ctx: MutationContext,
  args: SourceArgs
) => Promise<unknown>

/** Loads Convex source code while resolving its extensionless local imports. */
async function loadCreateAndEnqueue(): Promise<CreateAndEnqueueHandler> {
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
              // Try the next local extension.
            }
          }
        }
        throw error
      }
    },
  })
  try {
    const loadedModule = (await import("../convex/sources.ts")) as unknown as {
      createAndEnqueue: { _handler: CreateAndEnqueueHandler }
    }
    return loadedModule.createAndEnqueue._handler
  } finally {
    hooks.deregister()
  }
}

test("createAndEnqueue deduplicates a part and requeues a failed matching job", async () => {
  const createAndEnqueue = await loadCreateAndEnqueue()
  const db = new MemoryDb()
  const projectId = await db.insert("projects", {
    title: "Import test",
    createdAt: Date.now(),
  })
  const input: SourceArgs = {
    projectId,
    filename: "manual (Part 1 of 2).pdf",
    kind: "pdf",
    extractedText: "[Part 1 of 2]\nA chapter.",
    originalUrl: "https://example.com/manual.pdf",
  }

  const first = (await createAndEnqueue({ db }, input)) as {
    sourceId: string
    jobId: string
    status: string
  }
  const second = (await createAndEnqueue({ db }, input)) as typeof first
  assert.equal(second.sourceId, first.sourceId)
  assert.equal(second.jobId, first.jobId)
  assert.equal(db.count("sources"), 1)
  assert.equal(db.count("preparationJobs"), 1)

  await db.patch(first.jobId, {
    status: "failed",
    nextChunkOrdinal: 3,
    lastError: "temporary failure",
  })
  const retry = (await createAndEnqueue({ db }, input)) as typeof first
  const retriedJob = await db.get(first.jobId)
  assert.equal(retry.sourceId, first.sourceId)
  assert.equal(retry.jobId, first.jobId)
  assert.equal(retry.status, "queued")
  assert.equal(retriedJob?.status, "queued")
  assert.equal(retriedJob?.nextChunkOrdinal, 3)
  assert.equal(db.count("sources"), 1)
  assert.equal(db.count("preparationJobs"), 1)
})
