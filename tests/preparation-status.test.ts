/**
 * Verifies that job status covers a whole project's sources. The Sources page
 * sends every source ID in one query, so a module with more than 20 sources
 * once crashed the page.
 */

import assert from "node:assert/strict"
import test from "node:test"

type Job = {
  _id: string
  projectId: string
  sourceId: string
  status: "queued" | "leased" | "failed" | "completed"
  nextChunkOrdinal: number
  createdAt: number
  updatedAt: number
}
type JobStatusArgs = { projectId: string; sourceIds?: string[] }
type JobStatusHandler = (
  ctx: { db: ReturnType<typeof memoryDb> },
  args: JobStatusArgs
) => Promise<Array<{ sourceId: string; status: string }>>

/**
 * Builds the smallest Convex-like reader the job-status query uses: an
 * equality-filtered index query whose `first()` returns the first match.
 */
function memoryDb(jobs: Job[]) {
  return {
    query: (tableName: string) => {
      void tableName
      return {
        withIndex: (
          indexName: string,
          range: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
        ) => {
          void indexName
          const conditions: Array<[string, unknown]> = []
          const builder = {
            eq: (field: string, value: unknown) => {
              conditions.push([field, value])
              return builder
            },
          }
          range(builder)
          const rows = jobs.filter((job) =>
            conditions.every(
              ([field, value]) => job[field as keyof Job] === value
            )
          )
          const ordered = {
            first: async () => rows[0] ?? null,
          }
          return { order: () => ordered }
        },
      }
    },
  }
}

/** Loads the query handler and its limit, resolving extensionless imports. */
async function loadJobStatus(): Promise<{
  handler: JobStatusHandler
  limit: number
}> {
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
    const loaded = (await import("../convex/preparation.ts")) as unknown as {
      listJobsForProject: { _handler: JobStatusHandler }
      MAX_JOB_STATUS_SOURCES: number
    }
    return {
      handler: loaded.listJobsForProject._handler,
      limit: loaded.MAX_JOB_STATUS_SOURCES,
    }
  } finally {
    hooks.deregister()
  }
}

test("job status covers a module with more than 20 sources", async () => {
  const { handler } = await loadJobStatus()
  const sourceIds = Array.from({ length: 53 }, (_, i) => `sources:${i}`)
  const jobs: Job[] = sourceIds.slice(0, 3).map((sourceId, i) => ({
    _id: `preparationJobs:${i}`,
    projectId: "projects:1",
    sourceId,
    status: "completed",
    nextChunkOrdinal: 0,
    createdAt: i,
    updatedAt: i,
  }))

  const result = await handler(
    { db: memoryDb(jobs) },
    { projectId: "projects:1", sourceIds }
  )

  assert.deepEqual(
    result.map((job) => job.sourceId),
    sourceIds.slice(0, 3)
  )
})

test("job status still rejects requests above its limit", async () => {
  const { handler, limit } = await loadJobStatus()
  const sourceIds = Array.from({ length: limit + 1 }, (_, i) => `sources:${i}`)

  await assert.rejects(
    handler({ db: memoryDb([]) }, { projectId: "projects:1", sourceIds }),
    new RegExp(`at most ${limit} sources`)
  )
})
