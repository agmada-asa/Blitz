/** Verifies per-notification read tracking, unread count computation, and local storage serialization. */

import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"

import { isNotificationInCurrentChat } from "../lib/notifications.ts"

/** Browser storage key for individual read notification IDs. */
const READ_IDS_KEY = "blitz-notifications-read-ids-v1"
/** Legacy browser storage key for the latest time the notification center was opened. */
const LAST_READ_KEY = "blitz-notifications-last-read-v1"
/** Maximum read notification identifiers kept in local storage. */
const MAX_READ_IDS = 200

/** Minimal simulated local storage for testing persistence and migration. */
class MockStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

/** Pure helper modeling the notification provider's storage reader. */
function readStoredReadIds(storage: MockStorage): { ids: Set<string>; initialized: boolean } {
  const stored = storage.getItem(READ_IDS_KEY)
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return {
          ids: new Set(
            parsed.filter((id): id is string => typeof id === "string")
          ),
          initialized: true,
        }
      }
    } catch {
      // Fall through to uninitialized if corrupted.
    }
  }
  return { ids: new Set(), initialized: false }
}

/** Pure helper modeling the notification provider's legacy migration logic. */
function migrateOrInitializeReadIds(
  storage: MockStorage,
  notifications: Array<{ id: string; updatedAt: number }>
): Set<string> {
  const storedState = readStoredReadIds(storage)
  if (storedState.initialized) {
    return storedState.ids
  }

  const legacyStored = storage.getItem(LAST_READ_KEY)
  const legacyLastReadAt = legacyStored ? Number.parseInt(legacyStored, 10) : null

  if (legacyLastReadAt !== null && Number.isFinite(legacyLastReadAt)) {
    const migrated = new Set<string>()
    for (const item of notifications) {
      if (item.updatedAt <= legacyLastReadAt) {
        migrated.add(item.id)
      }
    }
    const serialized = [...migrated].slice(-MAX_READ_IDS)
    storage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
    return new Set(serialized)
  }

  storage.setItem(READ_IDS_KEY, JSON.stringify([]))
  return new Set()
}

/** Pure helper modeling marking one notification as read. */
function markAsRead(
  storage: MockStorage,
  current: Set<string>,
  id: string
): Set<string> {
  if (current.has(id)) return current
  const updated = new Set(current)
  updated.add(id)
  const serialized = [...updated].slice(-MAX_READ_IDS)
  storage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
  return new Set(serialized)
}

/** Pure helper modeling marking one notification as unread. */
function markAsUnread(
  storage: MockStorage,
  current: Set<string>,
  id: string
): Set<string> {
  if (!current.has(id)) return current
  const updated = new Set(current)
  updated.delete(id)
  const serialized = [...updated]
  storage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
  return updated
}

/** Pure helper modeling marking all notifications as read. */
function markAllRead(
  storage: MockStorage,
  current: Set<string>,
  notifications: Array<{ id: string }>
): Set<string> {
  const updated = new Set(current)
  for (const item of notifications) {
    updated.add(item.id)
  }
  const serialized = [...updated].slice(-MAX_READ_IDS)
  storage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
  return new Set(serialized)
}

/** Computes the unread count from notifications and read IDs. */
function computeUnreadCount(
  notifications: Array<{ id: string }>,
  readIds: Set<string>
): number {
  return notifications.filter((item) => !readIds.has(item.id)).length
}

describe("Notification read tracking", () => {
  let storage: MockStorage

  beforeEach(() => {
    storage = new MockStorage()
  })

  it("leaves notifications unread on initial load until explicitly clicked or marked", () => {
    const notifications = [
      { id: "prep:1", updatedAt: 1000 },
      { id: "research:2", updatedAt: 2000 },
      { id: "chat:3", updatedAt: 3000 },
    ]

    const readIds = migrateOrInitializeReadIds(storage, notifications)
    assert.equal(readIds.size, 0)
    assert.equal(computeUnreadCount(notifications, readIds), 3)
    assert.equal(readIds.has("prep:1"), false)
    assert.equal(readIds.has("research:2"), false)
    assert.equal(readIds.has("chat:3"), false)
  })

  it("marks only the clicked notification as read and retains others as unread", () => {
    const notifications = [
      { id: "prep:1", updatedAt: 1000 },
      { id: "research:2", updatedAt: 2000 },
    ]

    let readIds = migrateOrInitializeReadIds(storage, notifications)
    assert.equal(computeUnreadCount(notifications, readIds), 2)

    // User clicks the second notification
    readIds = markAsRead(storage, readIds, "research:2")
    assert.equal(readIds.has("prep:1"), false, "prep:1 must stay unread")
    assert.equal(readIds.has("research:2"), true, "research:2 must be read")
    assert.equal(computeUnreadCount(notifications, readIds), 1)

    // Verify stored JSON matches
    const stored = JSON.parse(storage.getItem(READ_IDS_KEY) ?? "[]")
    assert.deepEqual(stored, ["research:2"])
  })

  it("can toggle an item back to unread", () => {
    const notifications = [{ id: "prep:1", updatedAt: 1000 }]
    let readIds = migrateOrInitializeReadIds(storage, notifications)

    readIds = markAsRead(storage, readIds, "prep:1")
    assert.equal(readIds.has("prep:1"), true)
    assert.equal(computeUnreadCount(notifications, readIds), 0)

    readIds = markAsUnread(storage, readIds, "prep:1")
    assert.equal(readIds.has("prep:1"), false)
    assert.equal(computeUnreadCount(notifications, readIds), 1)
  })

  it("marks all notifications as read when markAllRead is triggered", () => {
    const notifications = [
      { id: "prep:1", updatedAt: 1000 },
      { id: "research:2", updatedAt: 2000 },
      { id: "chat:3", updatedAt: 3000 },
    ]

    let readIds = migrateOrInitializeReadIds(storage, notifications)
    assert.equal(computeUnreadCount(notifications, readIds), 3)

    readIds = markAllRead(storage, readIds, notifications)
    assert.equal(computeUnreadCount(notifications, readIds), 0)
    assert.equal(readIds.has("prep:1"), true)
    assert.equal(readIds.has("research:2"), true)
    assert.equal(readIds.has("chat:3"), true)
  })

  it("migrates from legacy lastReadAt timestamp without losing newer unread items", () => {
    // Legacy timestamp set at t = 1500
    storage.setItem(LAST_READ_KEY, "1500")

    const notifications = [
      { id: "prep:1", updatedAt: 1000 }, // Older than legacy: should be read
      { id: "research:2", updatedAt: 1500 }, // Exactly at legacy: should be read
      { id: "chat:3", updatedAt: 2000 }, // Newer than legacy: should be UNREAD
    ]

    const readIds = migrateOrInitializeReadIds(storage, notifications)
    assert.equal(readIds.has("prep:1"), true)
    assert.equal(readIds.has("research:2"), true)
    assert.equal(readIds.has("chat:3"), false)
    assert.equal(computeUnreadCount(notifications, readIds), 1)
  })

  it("bounds the stored read identifiers to MAX_READ_IDS", () => {
    let readIds = new Set<string>()
    for (let i = 0; i < 250; i++) {
      readIds = markAsRead(storage, readIds, `item:${i}`)
    }

    assert.equal(readIds.size, MAX_READ_IDS)
    const stored = JSON.parse(storage.getItem(READ_IDS_KEY) ?? "[]")
    assert.equal(stored.length, MAX_READ_IDS)
    assert.equal(readIds.has("item:0"), false, "oldest entries evicted")
    assert.equal(readIds.has("item:249"), true, "latest entries preserved")
  })
})

describe("Chat notification targeting", () => {
  it("matches a workspace reply only when its chat is open", () => {
    const href = "/chat?chatId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    assert.equal(
      isNotificationInCurrentChat(
        "workspace-reply",
        href,
        "/chat",
        "?chatId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ),
      true
    )
    assert.equal(
      isNotificationInCurrentChat(
        "workspace-reply",
        href,
        "/chat",
        "?chatId=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ),
      false
    )
  })

  it("matches a card reply only inside the same card chat interface", () => {
    const href =
      "/chat?projectId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&itemId=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    assert.equal(
      isNotificationInCurrentChat(
        "card-reply",
        href,
        "/chat",
        "?projectId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&itemId=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ),
      true
    )
    assert.equal(
      isNotificationInCurrentChat(
        "card-reply",
        href,
        "/notifications",
        ""
      ),
      false
    )
  })
})
