/**
 * Verifies the Weak topics drill end to end against the Practice queries: the
 * overview marks which weak concepts a drill can ask about, and the drill with
 * `focus: "weak"` asks only about weak concepts. Concepts that only exam paper
 * questions cover can be weak but have no practice questions, so the Practice
 * screen must not promise to drill them.
 */

import assert from "node:assert/strict"
import test from "node:test"

/** A stored document in the in-memory tables. */
type Row = Record<string, unknown> & { _id: string }
/** A Convex query handler called with the in-memory reader. */
type Handler = (ctx: { db: ReturnType<typeof memoryDb> }, args: Record<string, unknown>) => Promise<unknown>

/**
 * Builds the smallest Convex-like reader the Practice queries use:
 * equality-filtered index queries with `collect()` and `order().first()`,
 * and `get()` by ID.
 * @param tables Rows per table name.
 */
function memoryDb(tables: Record<string, Row[]>) {
  return {
    get: async (id: string) =>
      Object.values(tables)
        .flat()
        .find((row) => row._id === id) ?? null,
    query: (table: string) => ({
      withIndex: (
        _index: string,
        range: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        const conditions: Array<[string, unknown]> = []
        const builder = {
          eq: (field: string, value: unknown) => {
            conditions.push([field, value])
            return builder
          },
        }
        range(builder)
        const rows = (tables[table] ?? []).filter((row) =>
          conditions.every(([field, value]) => row[field] === value)
        )
        return {
          collect: async () => rows,
          order: () => ({ first: async () => rows.at(-1) ?? null }),
        }
      },
    }),
  }
}

/** Loads the Practice query handlers, resolving extensionless local imports. */
async function practiceHandlers(): Promise<{ overview: Handler; drill: Handler }> {
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
    const practice = (await import("../convex/practice.ts")) as unknown as Record<
      "overview" | "drill",
      { _handler: Handler }
    >
    return { overview: practice.overview._handler, drill: practice.drill._handler }
  } finally {
    hook.deregister()
  }
}

/** A single-choice question on a concept; `origin: "exam"` makes it a paper question. */
function question(id: string, conceptId: string, origin?: "exam"): Row {
  return {
    _id: id,
    projectId: "p1",
    unitId: "u1",
    conceptId,
    type: "single-choice",
    title: id,
    question: `Question ${id}?`,
    body: "",
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    correctOptionId: "a",
    sourceIds: [],
    createdAt: 1,
    ...(origin ? { origin } : {}),
  }
}

/** A concept review whose last answer was wrong, which makes the concept weak. */
function weakReview(conceptId: string): Row {
  return {
    _id: `r-${conceptId}`,
    projectId: "p1",
    conceptId,
    attemptCount: 1,
    correctCount: 0,
    consecutiveCorrect: 0,
    lastOutcome: "incorrect",
    dueAt: 0,
  }
}

/** One unit with a weak drilled concept, a strong one, and a weak exam-only one. */
function project() {
  return memoryDb({
    units: [{ _id: "u1", projectId: "p1", title: "Week 1", order: 0 }],
    concepts: [
      { _id: "c-weak", projectId: "p1", unitId: "u1", title: "Heaps" },
      { _id: "c-strong", projectId: "p1", unitId: "u1", title: "Stacks" },
      { _id: "c-exam", projectId: "p1", unitId: "u1", title: "Tries" },
    ],
    learningItems: [
      question("q-weak", "c-weak"),
      question("q-strong", "c-strong"),
      question("q-exam", "c-exam", "exam"),
    ],
    conceptReviews: [
      weakReview("c-weak"),
      {
        _id: "r-strong",
        projectId: "p1",
        conceptId: "c-strong",
        attemptCount: 3,
        correctCount: 3,
        consecutiveCorrect: 3,
        lastOutcome: "correct",
        dueAt: Number.MAX_SAFE_INTEGER,
      },
      weakReview("c-exam"),
    ],
    questionGenerations: [],
  })
}

test("the overview marks exam-only weak concepts as not drillable", async () => {
  const { overview } = await practiceHandlers()
  const result = (await overview({ db: project() }, { projectId: "p1", now: 10 })) as {
    weakConcepts: Array<{ title: string; drillable: boolean }>
  }
  assert.deepEqual(
    result.weakConcepts.map((concept) => [concept.title, concept.drillable]).sort(),
    [
      ["Heaps", true],
      ["Tries", false],
    ]
  )
})

test("the weak-topics drill asks only about weak concepts", async () => {
  const { drill } = await practiceHandlers()
  const all = (await drill({ db: project() }, { projectId: "p1", now: 10 })) as Array<{ itemId: string }>
  assert.deepEqual(all.map((entry) => entry.itemId).sort(), ["q-strong", "q-weak"])
  const weak = (await drill({ db: project() }, { projectId: "p1", now: 10, focus: "weak" })) as Array<{
    itemId: string
  }>
  assert.deepEqual(
    weak.map((entry) => entry.itemId),
    ["q-weak"]
  )
})
