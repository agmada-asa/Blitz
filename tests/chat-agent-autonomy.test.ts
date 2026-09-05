/** Verifies agent autonomy validation, local storage caching, and multi-listener synchronization. */

import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"

import {
  AGENT_AUTONOMY_STORAGE_KEY,
  DEFAULT_AGENT_AUTONOMY,
  LEGACY_AGENT_AUTONOMY_STORAGE_KEY,
  isChatAgentAutonomy,
  readCachedAgentAutonomy,
  subscribeToCachedAgentAutonomy,
  writeCachedAgentAutonomy,
  type AgentAutonomyStorage,
} from "../lib/agent-autonomy.ts"

/** In-memory storage mock that mirrors the browser localStorage API for unit testing. */
class MockStorage implements AgentAutonomyStorage {
  private store = new Map<string, string>()

  /** Reads a stored string key or returns null if not set. */
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  /** Writes a string key-value pair. */
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  /** Removes a single key from storage. */
  removeItem(key: string): void {
    this.store.delete(key)
  }

  /** Clears all stored key-value pairs. */
  clear(): void {
    this.store.clear()
  }
}

/** Faulty storage mock that throws on operations to verify graceful degradation. */
class FailingStorage implements AgentAutonomyStorage {
  /** Always throws to simulate storage access restrictions. */
  getItem(): string | null {
    throw new Error("SecurityError: Access is denied")
  }

  /** Always throws to simulate quota exceeded or storage failure. */
  setItem(): void {
    throw new Error("QuotaExceededError: Storage quota exceeded")
  }
}

describe("Chat agent access level caching", () => {
  let storage: MockStorage

  beforeEach(() => {
    storage = new MockStorage()
  })

  describe("isChatAgentAutonomy", () => {
    it("accepts supported autonomy levels", () => {
      assert.equal(isChatAgentAutonomy("approval"), true)
      assert.equal(isChatAgentAutonomy("project"), true)
      assert.equal(isChatAgentAutonomy("full"), true)
    })

    it("rejects unknown or invalid autonomy values", () => {
      assert.equal(isChatAgentAutonomy(""), false)
      assert.equal(isChatAgentAutonomy("admin"), false)
      assert.equal(isChatAgentAutonomy("unrestricted"), false)
      assert.equal(isChatAgentAutonomy(null), false)
      assert.equal(isChatAgentAutonomy(undefined), false)
      assert.equal(isChatAgentAutonomy(123), false)
      assert.equal(isChatAgentAutonomy({}), false)
      assert.equal(isChatAgentAutonomy([]), false)
    })
  })

  describe("readCachedAgentAutonomy", () => {
    it("returns default approval autonomy when storage is empty", () => {
      assert.equal(readCachedAgentAutonomy(storage), DEFAULT_AGENT_AUTONOMY)
      assert.equal(readCachedAgentAutonomy(storage), "approval")
    })

    it("reads cached full access level", () => {
      storage.setItem(AGENT_AUTONOMY_STORAGE_KEY, "full")
      assert.equal(readCachedAgentAutonomy(storage), "full")
    })

    it("reads cached project access level", () => {
      storage.setItem(AGENT_AUTONOMY_STORAGE_KEY, "project")
      assert.equal(readCachedAgentAutonomy(storage), "project")
    })

    it("reads cached require approval level", () => {
      storage.setItem(AGENT_AUTONOMY_STORAGE_KEY, "approval")
      assert.equal(readCachedAgentAutonomy(storage), "approval")
    })

    it("falls back to legacy storage key when versioned key is missing", () => {
      storage.setItem(LEGACY_AGENT_AUTONOMY_STORAGE_KEY, "full")
      assert.equal(readCachedAgentAutonomy(storage), "full")
    })

    it("prioritizes versioned key over legacy storage key", () => {
      storage.setItem(LEGACY_AGENT_AUTONOMY_STORAGE_KEY, "project")
      storage.setItem(AGENT_AUTONOMY_STORAGE_KEY, "full")
      assert.equal(readCachedAgentAutonomy(storage), "full")
    })

    it("falls back to approval when stored value is corrupted", () => {
      storage.setItem(AGENT_AUTONOMY_STORAGE_KEY, "unknown-level")
      assert.equal(readCachedAgentAutonomy(storage), "approval")
    })

    it("falls back to approval when storage throws an exception", () => {
      const failingStorage = new FailingStorage()
      assert.equal(readCachedAgentAutonomy(failingStorage), "approval")
    })

    it("falls back to approval when storage is null", () => {
      assert.equal(readCachedAgentAutonomy(null), "approval")
    })
  })

  describe("writeCachedAgentAutonomy", () => {
    it("persists full access level to storage", () => {
      writeCachedAgentAutonomy("full", storage)
      assert.equal(storage.getItem(AGENT_AUTONOMY_STORAGE_KEY), "full")
    })

    it("persists project access level to storage", () => {
      writeCachedAgentAutonomy("project", storage)
      assert.equal(storage.getItem(AGENT_AUTONOMY_STORAGE_KEY), "project")
    })

    it("persists approval access level to storage", () => {
      writeCachedAgentAutonomy("approval", storage)
      assert.equal(storage.getItem(AGENT_AUTONOMY_STORAGE_KEY), "approval")
    })

    it("gracefully catches storage failures without throwing", () => {
      const failingStorage = new FailingStorage()
      assert.doesNotThrow(() => {
        writeCachedAgentAutonomy("full", failingStorage)
      })
    })

    it("notifies subscribed listeners when writing", () => {
      let callCount = 0
      const unsubscribe = subscribeToCachedAgentAutonomy(() => {
        callCount += 1
      })

      writeCachedAgentAutonomy("full", storage)
      assert.equal(callCount, 1)

      writeCachedAgentAutonomy("project", storage)
      assert.equal(callCount, 2)

      unsubscribe()
      writeCachedAgentAutonomy("approval", storage)
      assert.equal(callCount, 2)
    })
  })
})
