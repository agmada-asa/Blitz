/** Verifies the shared server Convex client's URL lookup and its caller-specific unavailable errors. */

import assert from "node:assert/strict"
import test from "node:test"
import { serverConvexClient } from "../lib/server/convex.ts"

/** Environment keys the helper reads, cleared around each test. */
const KEYS = ["BLITZ_CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL", "CONVEX_URL"] as const

/**
 * Runs `body` with only the given Convex URLs set, then restores the
 * original environment so other tests are unaffected.
 */
function withConvexEnvironment(
  values: Partial<Record<(typeof KEYS)[number], string>>,
  body: () => void
): void {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of KEYS) delete process.env[key]
    Object.assign(process.env, values)
    body()
  } finally {
    for (const key of KEYS)
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
  }
}

test("throws the default error when no Convex URL is configured", () => {
  withConvexEnvironment({}, () => {
    assert.throws(() => serverConvexClient(), {
      message: "Blitz's database is not configured",
    })
  })
})

test("throws the caller's error when no Convex URL is configured", () => {
  class ServiceError extends Error {}
  withConvexEnvironment({}, () => {
    assert.throws(
      () => serverConvexClient(() => new ServiceError("Chat is unavailable.")),
      (error) =>
        error instanceof ServiceError && error.message === "Chat is unavailable."
    )
  })
})

test("reports a malformed URL with the caller's error, not the client's", () => {
  withConvexEnvironment({ BLITZ_CONVEX_URL: "not a url" }, () => {
    assert.throws(
      () => serverConvexClient(() => new Error("Sources are unavailable.")),
      { message: "Sources are unavailable." }
    )
  })
})

test("prefers the launcher URL, then the public URL, then CONVEX_URL", () => {
  withConvexEnvironment(
    {
      BLITZ_CONVEX_URL: "http://127.0.0.1:3001",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3002",
      CONVEX_URL: "http://127.0.0.1:3003",
    },
    () => assert.equal(serverConvexClient().url, "http://127.0.0.1:3001")
  )
  withConvexEnvironment(
    {
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3002",
      CONVEX_URL: "http://127.0.0.1:3003",
    },
    () => assert.equal(serverConvexClient().url, "http://127.0.0.1:3002")
  )
  withConvexEnvironment({ CONVEX_URL: "http://127.0.0.1:3003" }, () =>
    assert.equal(serverConvexClient().url, "http://127.0.0.1:3003")
  )
})
