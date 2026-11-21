/** Verifies how `blitz://` links map to app pages and when a browser page hands over to the desktop app. */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  linkArgument,
  linkPath,
  linkTarget,
  takeQueuedLinks,
} from "../electron/open-links.mjs"
import {
  desktopLink,
  isMacBrowser,
  shouldHandOff,
} from "../lib/client/desktop-links.ts"
import {
  declaresLinkScheme,
  desktopAppOpensLinks,
  isThisMachine,
} from "../lib/server/desktop-app.ts"

const origin = "http://127.0.0.1:3007"

test("a blitz link names a page by its path, with or without a host", () => {
  assert.equal(linkPath("blitz://projects/abc/learn/xyz"), "/projects/abc/learn/xyz")
  assert.equal(linkPath("blitz:///projects/abc"), "/projects/abc")
  assert.equal(linkPath("blitz://review?due=1#top"), "/review?due=1#top")
  assert.equal(linkPath("blitz://"), "/")
  assert.equal(linkPath("https://example.com/projects"), undefined)
  assert.equal(linkPath("not a url"), undefined)
})

test("finds the blitz link Windows and Linux pass on the command line", () => {
  assert.equal(
    linkArgument(["C:\\Blitz\\Blitz.exe", "--allow-file-access", "blitz://projects/abc"]),
    "blitz://projects/abc"
  )
  assert.equal(linkArgument(["/opt/blitz", "BLITZ://review"]), "BLITZ://review")
  assert.equal(linkArgument(["/opt/blitz", "--no-sandbox"]), undefined)
})

test("a blitz link can't leave the app's origin", () => {
  assert.equal(
    linkTarget("blitz://projects/abc", origin),
    `${origin}/projects/abc`
  )
  assert.equal(linkTarget("blitz:////evil.example/x", origin), `${origin}/evil.example/x`)
  assert.equal(linkTarget("blitz:///\\evil.example/x", origin), undefined)
  assert.equal(linkTarget("mailto:someone@example.com", origin), undefined)
})

test("links queued at launch are handed over once and the queue stops", () => {
  let stopped = false
  globalThis.blitzLinkQueue = {
    links: ["blitz://review"],
    stop: () => {
      stopped = true
    },
  }
  assert.deepEqual(takeQueuedLinks(), ["blitz://review"])
  assert.equal(stopped, true)
  assert.deepEqual(takeQueuedLinks(), [])
})

test("a page's desktop link round-trips to the same path", () => {
  const link = desktopLink({
    pathname: "/projects/abc/learn/xyz",
    search: "?section=2",
    hash: "#q1",
  })
  assert.equal(link, "blitz://projects/abc/learn/xyz?section=2#q1")
  assert.equal(linkPath(link), "/projects/abc/learn/xyz?section=2#q1")
  assert.equal(linkPath(desktopLink({ pathname: "/", search: "", hash: "" })), "/")
})

test("only a Mac desktop browser counts, not an iPad", () => {
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"
  assert.equal(isMacBrowser(mac, 0), true)
  assert.equal(isMacBrowser(mac, 5), false)
  assert.equal(
    isMacBrowser("Mozilla/5.0 (Linux; Android 14; SM-A546B) Chrome/140.0 Mobile", 5),
    false
  )
})

test("only a fresh arrival from a link hands over", () => {
  const arrival = {
    inDesktopApp: false,
    macBrowser: true,
    automated: false,
    preference: null,
    navigationType: "navigate",
    referrer: "",
    origin,
  } as const
  assert.equal(shouldHandOff(arrival), true)
  assert.equal(shouldHandOff({ ...arrival, preference: "app" }), true)
  assert.equal(shouldHandOff({ ...arrival, referrer: "https://mail.example/" }), true)
  assert.equal(shouldHandOff({ ...arrival, preference: "browser" }), false)
  assert.equal(shouldHandOff({ ...arrival, inDesktopApp: true }), false)
  assert.equal(shouldHandOff({ ...arrival, macBrowser: false }), false)
  assert.equal(shouldHandOff({ ...arrival, automated: true }), false)
  assert.equal(shouldHandOff({ ...arrival, navigationType: "reload" }), false)
  assert.equal(shouldHandOff({ ...arrival, navigationType: "back_forward" }), false)
  assert.equal(shouldHandOff({ ...arrival, referrer: `${origin}/settings` }), false)
})

test("only an installed app that declares the blitz scheme opens links", async () => {
  const withScheme = `<plist><dict><key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Blitz</string>
    <key>CFBundleURLSchemes</key><array><string>blitz</string></array>
  </dict></array></dict></plist>`
  assert.equal(declaresLinkScheme(withScheme), true)
  assert.equal(
    declaresLinkScheme("<plist><dict><key>CFBundleName</key><string>blitz</string></dict></plist>"),
    false
  )

  const home = await mkdtemp(join(tmpdir(), "blitz-desktop-app-"))
  try {
    const older = join(home, "Older.app")
    const current = join(home, "Blitz.app")
    await mkdir(join(older, "Contents"), { recursive: true })
    await writeFile(join(older, "Contents", "Info.plist"), "<plist><dict/></plist>")
    if (process.platform === "darwin") {
      assert.equal(await desktopAppOpensLinks([older, join(home, "Missing.app")]), false)
      await mkdir(join(current, "Contents"), { recursive: true })
      await writeFile(join(current, "Contents", "Info.plist"), withScheme)
      assert.equal(await desktopAppOpensLinks([older, current]), true)
    } else {
      assert.equal(await desktopAppOpensLinks([older]), false)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("only a browser on this Mac is told about its app", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1" }, { address: "::1" }],
    en0: [{ address: "192.168.1.20" }, { address: "fe80::1c2b:3a4d:5e6f:7081" }],
    utun4: [{ address: "100.64.0.7" }],
  } as unknown as Parameters<typeof isThisMachine>[1]
  assert.equal(isThisMachine("127.0.0.1", interfaces), true)
  assert.equal(isThisMachine("::1", interfaces), true)
  assert.equal(isThisMachine("::ffff:127.0.0.1", interfaces), true)
  // The Mac opening its own LAN or Tailscale address.
  assert.equal(isThisMachine("::ffff:192.168.1.20", interfaces), true)
  assert.equal(isThisMachine("100.64.0.7", interfaces), true)
  assert.equal(isThisMachine("FE80::1C2B:3A4D:5E6F:7081%en0", interfaces), true)
  // Another device, directly or through a proxy that appends the peer.
  assert.equal(isThisMachine("100.64.0.9", interfaces), false)
  assert.equal(isThisMachine("127.0.0.1, 100.64.0.9", interfaces), false)
  assert.equal(isThisMachine("100.64.0.9, 100.64.0.7", interfaces), true)
  assert.equal(isThisMachine(null, interfaces), false)
  assert.equal(isThisMachine("", interfaces), false)
})
