/** Checks that generated concept links keep stable endpoints and source evidence. */

import assert from "node:assert/strict"
import test from "node:test"
import { validateConceptConnections } from "../lib/concept-map.ts"

/** Returns one supported link from a new lesson page to an existing concept. */
function connection() {
  return {
    from: { kind: "page", key: "cell-division" },
    to: { kind: "concept", id: "concept-1" },
    kind: "contrasts_with",
    explanation: "The source distinguishes these two processes.",
    evidence: [{ sectionId: "chunk-1", locator: "Page 3" }],
  }
}

/** Supplies the known pages, concepts, and included sections for one source. */
function options() {
  return {
    pageKeys: new Set(["cell-division"]),
    knownConceptIds: new Set(["concept-1"]),
    includedSectionIds: new Set(["chunk-1"]),
    extractedSectionIds: new Set(["chunk-1"]),
  }
}

/** Accepts a relationship that points to an included passage and saved concept. */
test("accepts a source-backed link between a new and existing concept", () => {
  assert.equal(validateConceptConnections([connection()], options()).length, 1)
})

/** Rejects references that could attach an unrelated concept or skipped section. */
test("rejects unknown concepts and unsupported evidence", () => {
  assert.throws(() =>
    validateConceptConnections(
      [{ ...connection(), to: { kind: "concept", id: "missing" } }],
      options()
    )
  )
  assert.throws(() =>
    validateConceptConnections(
      [
        {
          ...connection(),
          evidence: [{ sectionId: "chunk-2", locator: "Page 4" }],
        },
      ],
      options()
    )
  )
  assert.throws(() =>
    validateConceptConnections(
      [{ ...connection(), evidence: [{ locator: "Page 3" }] }],
      options()
    )
  )
})

/** Treats a symmetric reverse edge as the same link and forbids self links. */
test("rejects duplicate and self relationships", () => {
  assert.throws(() =>
    validateConceptConnections(
      [
        connection(),
        { ...connection(), from: connection().to, to: connection().from },
      ],
      options()
    )
  )
  assert.throws(() =>
    validateConceptConnections(
      [{ ...connection(), from: connection().to }],
      options()
    )
  )
})

/** Keeps original-file locators useful when extraction yielded no stable section IDs. */
test("accepts a file locator when automatic extraction is unavailable", () => {
  assert.equal(
    validateConceptConnections(
      [{ ...connection(), evidence: [{ locator: "Slide 4" }] }],
      {
        ...options(),
        includedSectionIds: new Set(),
        extractedSectionIds: new Set(),
      }
    ).length,
    1
  )
})
