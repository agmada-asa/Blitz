/** Verifies the local browser-origin guard used by state-changing chat routes. */

import assert from "node:assert/strict"
import test from "node:test"

import { isTrustedBlitzOrigin } from "../lib/server/request-origin.ts"

/** Creates a request with the browser and public-host headers under test. */
function browserRequest(
  requestUrl: string,
  origin?: string,
  host?: string
): Request {
  return new Request(requestUrl, {
    headers: {
      ...(origin ? { origin } : {}),
      ...(host ? { host } : {}),
    },
  })
}

test("accepts exact, loopback-alias, LAN, and native local requests", () => {
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest("http://localhost:3001/api/chat", "http://localhost:3001")
    ),
    true
  )
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest("http://localhost:3001/api/chat", "http://127.0.0.1:3001")
    ),
    true
  )
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest(
        "http://127.0.0.1:3001/api/chat",
        "http://192.168.0.55:3001",
        "192.168.0.55:3001"
      )
    ),
    true
  )
  assert.equal(
    isTrustedBlitzOrigin(browserRequest("http://localhost:3001/api/chat")),
    true
  )
})

test("uses the public Host header when Next reports an internal origin", () => {
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest(
        "http://127.0.0.1:3000/api/chat",
        "http://127.0.0.1:3001",
        "localhost:3001"
      )
    ),
    true
  )
})

test("rejects cross-site and wrong-port browser origins", () => {
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest("http://localhost:3001/api/chat", "https://example.com")
    ),
    false
  )
  assert.equal(
    isTrustedBlitzOrigin(
      browserRequest("http://localhost:3001/api/chat", "http://127.0.0.1:3002")
    ),
    false
  )
})
