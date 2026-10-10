/** Verifies that local Convex URLs follow the page host while hosted URLs stay fixed. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  isLocalHostname,
  resolveBrowserConvexUrl,
} from "../lib/client/convex-url.ts"

test("points a loopback Convex URL at the LAN host that served the page", () => {
  assert.equal(
    resolveBrowserConvexUrl("http://127.0.0.1:3212", "192.168.0.55"),
    "http://192.168.0.55:3212"
  )
})

test("recovers a stale LAN address after the Mac changes networks", () => {
  assert.equal(
    resolveBrowserConvexUrl("http://192.168.0.55:3212", "localhost"),
    "http://localhost:3212"
  )
  assert.equal(
    resolveBrowserConvexUrl("http://192.168.0.55:3212", "10.0.0.8"),
    "http://10.0.0.8:3212"
  )
})

test("supports Tailscale and mDNS hostnames", () => {
  assert.equal(
    resolveBrowserConvexUrl("http://127.0.0.1:3212", "100.101.1.2"),
    "http://100.101.1.2:3212"
  )
  assert.equal(
    resolveBrowserConvexUrl("http://127.0.0.1:3212", "macbook.local"),
    "http://macbook.local:3212"
  )
})

test("leaves hosted deployments and server rendering unchanged", () => {
  assert.equal(
    resolveBrowserConvexUrl("https://happy-otter-123.convex.cloud", "localhost"),
    "https://happy-otter-123.convex.cloud"
  )
  assert.equal(
    resolveBrowserConvexUrl("http://127.0.0.1:3212", undefined),
    "http://127.0.0.1:3212"
  )
  assert.equal(
    resolveBrowserConvexUrl("http://127.0.0.1:3212", "blitz.example.com"),
    "http://127.0.0.1:3212"
  )
  assert.equal(resolveBrowserConvexUrl("not a url", "localhost"), "not a url")
})

test("classifies private and public hostnames", () => {
  for (const host of ["localhost", "127.0.0.1", "10.2.3.4", "172.20.1.1"])
    assert.equal(isLocalHostname(host), true, host)
  for (const host of ["8.8.8.8", "172.32.0.1", "example.com", "256.1.1.1"])
    assert.equal(isLocalHostname(host), false, host)
})
