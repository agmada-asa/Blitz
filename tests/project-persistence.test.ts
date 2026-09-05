/** Verifies project rename validation and deletion boundaries without touching live study data. */
import assert from "node:assert/strict"
import test from "node:test"

/** Minimal project-owned record used by the indexed mutation test double. */
type Row = { _id: string; table: string; [key: string]: unknown }
/** Mutation signature under test. */
type Handler = (
  ctx: { db: MemoryDb },
  args: { projectId: string; title?: string }
) => Promise<unknown>
/** In-memory database that tracks writes so rejected deletions can be checked. */
class MemoryDb {
  rows: Row[] = []
  deleted: string[] = []
  /** Seeds a record using its table and supplied ownership fields. */
  seed(table: string, fields: Record<string, unknown>) {
    const row = { _id: `${table}:${this.rows.length}`, table, ...fields }
    this.rows.push(row)
    return row._id
  }
  /** Finds one document by its test ID. */
  async get(id: string) {
    return this.rows.find((row) => row._id === id) ?? null
  }
  /** Applies the rename fields to an existing record. */
  async patch(id: string, fields: Record<string, unknown>) {
    Object.assign((await this.get(id))!, fields)
  }
  /** Records deletion and removes the requested document. */
  async delete(id: string) {
    this.deleted.push(id)
    this.rows = this.rows.filter((row) => row._id !== id)
  }
  /** Filters one indexed ownership field and respects the mutation's read limit. */
  query(table: string) {
    return {
      withIndex: (
        _name: string,
        callback: (q: {
          eq: (field: string, value: unknown) => void
        }) => unknown
      ) => {
        let field = "",
          value: unknown
        callback({
          eq: (key, input) => {
            field = key
            value = input
          },
        })
        return {
          take: async (limit: number) =>
            this.rows
              .filter((row) => row.table === table && row[field] === value)
              .slice(0, limit),
        }
      },
    }
  }
}
/** Resolves the existing Convex module using the repository's Node test loader pattern. */
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
              // Try the next local extension.
            }
          }
        }
        throw error
      }
    },
  })
  try {
    const loadedModule = (await import("../convex/projects.ts")) as unknown as {
      renameProject: { _handler: Handler }
      deleteProject: { _handler: Handler }
    }
    return {
      rename: loadedModule.renameProject._handler,
      remove: loadedModule.deleteProject._handler,
    }
  } finally {
    hooks.deregister()
  }
}

test("rename trims names, rejects invalid names, and preserves related data", async () => {
  const { rename } = await loadHandlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Before", createdAt: 123 })
  const sourceId = db.seed("sources", { projectId })
  await rename({ db }, { projectId, title: "  After  " })
  assert.equal((await db.get(projectId))?.title, "After")
  assert.equal((await db.get(projectId))?.createdAt, 123)
  assert.ok(await db.get(sourceId))
  for (const title of [" ", "x".repeat(201)])
    await assert.rejects(rename({ db }, { projectId, title }))
  await assert.rejects(rename({ db }, { projectId: "missing", title: "Name" }))
})

test("delete removes every owned table and nested jobs, messages, and imports only for its project", async () => {
  const { remove } = await loadHandlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Delete" })
  const otherId = db.seed("projects", { title: "Keep" })
  for (const id of [projectId, otherId]) {
    for (const table of [
      "sources",
      "cards",
      "attempts",
      "topics",
      "concepts",
      "learningItems",
      "writingActivities",
      "studyEvents",
      "conceptReviews",
    ])
      db.seed(table, { projectId: id })
    const jobId = db.seed("preparationJobs", { projectId: id })
    db.seed("preparationChunks", { jobId })
    const conversationId = db.seed("conversations", { projectId: id })
    db.seed("conversationMessages", { conversationId })
    const proposalId = db.seed("researchProposals", { projectId: id })
    db.seed("researchProposalImports", { proposalId })
  }
  const expectedRemaining = db.rows.filter(
    (row) =>
      row._id === otherId ||
      row.projectId === otherId ||
      ([
        "preparationChunks",
        "conversationMessages",
        "researchProposalImports",
      ].includes(row.table) &&
        Number(row._id.split(":")[1]) > 16)
  )
  await remove({ db }, { projectId })
  assert.deepEqual(db.rows, expectedRemaining)
  assert.equal(db.deleted.at(-1), projectId)
  assert.equal(db.deleted.length, 16)
  await remove({ db }, { projectId })
  assert.equal(db.deleted.length, 16)
})

test("oversized deletion refuses before any writes", async () => {
  const { remove } = await loadHandlers()
  const db = new MemoryDb()
  const projectId = db.seed("projects", { title: "Large" })
  for (let i = 0; i < 2001; i++) db.seed("sources", { projectId })
  await assert.rejects(remove({ db }, { projectId }), /too large/)
  assert.equal(db.deleted.length, 0)
  assert.equal(db.rows.length, 2002)
})
