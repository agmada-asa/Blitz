/**
 * Checks how the MCP `organise` tool resolves what it changes and which Convex
 * mutations it calls, against a fake Blitz: a stubbed projects route and a
 * Convex client that records mutations. No running app is needed.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { getFunctionName } from "convex/server"
import { BlitzError, organise } from "../mcp/blitz.mjs"

/** A source as `units.listForProject` returns it, with only the fields the tool reads. */
const source = (id: string, filename: string) => ({
  id,
  filename,
  createdAt: 1,
})

/** One module's learning path: two weeks that reuse a file name, and a reference book. */
const PATH = {
  units: [
    { id: "u1", title: "Week 1", sources: [source("s1", "Slides.pdf")] },
    {
      id: "u2",
      title: "Week 2",
      sources: [source("s2", "Slides.pdf"), source("s3", "Lab 2.pdf")],
    },
    { id: "u3", title: "Week 3", sources: [] },
  ],
  unsortedSources: [],
  referenceSources: [source("s4", "Textbook.pdf")],
}

/**
 * Builds a fake Blitz with one module, "Databases", and stubs `fetch` for its projects route.
 *
 * @returns The fake and the mutations it received, as `[name, args]` pairs.
 */
function fakeBlitz(t: test.TestContext) {
  const mutations: [string, unknown][] = []
  t.mock.method(globalThis, "fetch", async () =>
    Response.json([{ id: "p1", title: "Databases", createdAt: 1 }])
  )
  const blitz = {
    app: "http://blitz.test",
    links: "http://blitz.test",
    convex: {
      query: async (ref: unknown) => {
        assert.equal(getFunctionName(ref as never), "units:listForProject")
        return PATH
      },
      mutation: async (ref: unknown, args: unknown) => {
        mutations.push([getFunctionName(ref as never), args])
      },
    },
  }
  return { blitz, mutations }
}

test("a file name several weeks share moves nothing and asks for an id", async (t) => {
  const { blitz, mutations } = fakeBlitz(t)
  await assert.rejects(
    organise(blitz, {
      action: "move_source",
      module: "Databases",
      source: "slides.pdf",
      unit: "Week 3",
    }),
    (error: Error) =>
      error instanceof BlitzError &&
      /Week 1 \(id s1\)/.test(error.message) &&
      /Week 2 \(id s2\)/.test(error.message)
  )
  assert.deepEqual(mutations, [])
})

test("a source moves by id, by unique name, or out of every unit", async (t) => {
  const { blitz, mutations } = fakeBlitz(t)
  await organise(blitz, {
    action: "move_source",
    module: "Databases",
    source: "s2",
    unit: "Week 3",
  })
  await organise(blitz, {
    action: "move_source",
    module: "Databases",
    source: "lab 2",
    unit: "week 1",
  })
  await organise(blitz, {
    action: "move_source",
    module: "Databases",
    source: "Lab 2.pdf",
  })
  assert.deepEqual(mutations, [
    ["units:moveSource", { sourceId: "s2", unitId: "u3" }],
    ["units:moveSource", { sourceId: "s3", unitId: "u1" }],
    ["units:moveSource", { sourceId: "s3" }],
  ])
})

test("moving a reference book says it stops backing up every unit", async (t) => {
  const { blitz } = fakeBlitz(t)
  const result = await organise(blitz, {
    action: "move_source",
    module: "Databases",
    source: "Textbook.pdf",
    unit: "Week 2",
  })
  assert.match(result, /no longer a reference book/)
})

test("a unit moves to a position one place at a time", async (t) => {
  const { blitz, mutations } = fakeBlitz(t)
  const result = await organise(blitz, {
    action: "move_unit",
    module: "Databases",
    unit: "Week 3",
    position: 1,
  })
  assert.equal(result, 'Moved "Week 3" to position 1 of 3 in Databases.')
  assert.deepEqual(mutations, [
    ["units:move", { unitId: "u3", direction: "earlier" }],
    ["units:move", { unitId: "u3", direction: "earlier" }],
  ])
})

test("archiving needs only the module, and a rename without a title changes nothing", async (t) => {
  const { blitz, mutations } = fakeBlitz(t)
  await organise(blitz, { action: "archive_module", module: "data" })
  await assert.rejects(
    organise(blitz, { action: "rename_module", module: "Databases" }),
    BlitzError
  )
  assert.deepEqual(mutations, [
    ["projects:setProjectArchived", { projectId: "p1", archived: true }],
  ])
})
