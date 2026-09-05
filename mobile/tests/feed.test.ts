/** Verifies native feed merge and offline filter behavior without React Native runtime setup. */

import assert from "node:assert/strict"
import test from "node:test"

import { appendFeedPage, filterCards, mergeFeedMetadata } from "../lib/feed.ts"
import { legacyMigrationAction } from "../lib/storage-policy.ts"
import type { MobileFeedPayload } from "../lib/contracts"

/** Creates a minimal valid explanation card fixture. */
function card(id: string, projectId: string, topicId?: string) {
  return {
    id,
    projectId,
    ...(topicId ? { topicId } : {}),
    conceptId: `concept-${id}`,
    title: id,
    sourceLabel: "Source",
    sourceIds: [`source-${id}`],
    type: "explain" as const,
    body: "Body",
  }
}

/** Creates a small feed fixture with optional card pages. */
function feed(
  cards: ReturnType<typeof card>[],
  cursor: string | null = null
): MobileFeedPayload {
  return {
    cards,
    projects: [
      { id: "p1", title: "Project 1" },
      { id: "p2", title: "Project 2" },
    ],
    topics: [
      { id: "t1", projectId: "p1", title: "Topic 1" },
      { id: "t2", projectId: "p2", title: "Topic 2" },
    ],
    continueCursor: cursor,
  }
}

test("same-query refresh preserves loaded pages and metadata", () => {
  const merged = appendFeedPage(
    feed([card("a", "p1")], "next"),
    feed([card("b", "p1")])
  )
  assert.deepEqual(
    merged.cards.map(({ id }) => id),
    ["a", "b"]
  )
  assert.equal(merged.continueCursor, null)
})

test("new filter replaces cards so offline fallback cannot show another filter", () => {
  const next = mergeFeedMetadata(feed([card("a", "p1", "t1")]), feed([]))
  assert.deepEqual(filterCards(next, "p2", undefined), [])
  assert.deepEqual(
    filterCards(feed([card("a", "p1", "t1")]), "p2", undefined),
    []
  )
})

test("legacy migration claims once and never remaps after a server change", () => {
  assert.equal(legacyMigrationAction(null, true, "http://a"), "claim")
  assert.equal(legacyMigrationAction("http://a", true, "http://b"), "skip")
  assert.equal(legacyMigrationAction(null, true, undefined), "orphan")
  assert.equal(legacyMigrationAction("orphaned", true, "http://b"), "skip")
  assert.equal(legacyMigrationAction("http://a", true, "http://a"), "claim")
})
