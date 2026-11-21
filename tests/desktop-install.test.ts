/**
 * Verifies `npm run desktop:install`'s parts that run without packaging an
 * app: the Windows icon and Linux `.desktop` helpers, and the Blitz home
 * setup leaving an installed release alone.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { desktopExecQuote, packIco } from "../scripts/desktop-files.mjs"
import { ensureLocalDatabase, setUpHome } from "../scripts/install-home.mjs"

test("packs PNGs into an icon whose directory points at each image", () => {
  const small = Buffer.from("small-png")
  const large = Buffer.from("large-png-bytes")
  const ico = packIco([
    { size: 16, png: small },
    { size: 256, png: large },
  ])
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)
  // First entry: 16 px, its bytes right after the header and both entries.
  assert.equal(ico.readUInt8(6), 16)
  assert.equal(ico.readUInt32LE(6 + 8), small.length)
  assert.equal(ico.readUInt32LE(6 + 12), 6 + 32)
  // Second entry: 256 px is written as 0.
  assert.equal(ico.readUInt8(22), 0)
  const offset = ico.readUInt32LE(22 + 12)
  assert.equal(ico.subarray(offset, offset + large.length).toString(), "large-png-bytes")
})

test("quotes a desktop entry's program path only when it needs it", () => {
  assert.equal(desktopExecQuote("/home/sam/.local/share/blitz/app/blitz"), "/home/sam/.local/share/blitz/app/blitz")
  assert.equal(desktopExecQuote("/home/sam/My Apps/blitz"), '"/home/sam/My Apps/blitz"')
  assert.equal(desktopExecQuote('/home/a"b/$x'), '"/home/a\\"b/\\$x"')
})

/** Runs Git in a directory for fixture setup. */
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

test("a checkout that already has a database is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-database-"))
  try {
    await mkdir(join(root, ".convex", "local", "default"), { recursive: true })
    await writeFile(join(root, ".convex", "local", "default", "config.json"), "{}")
    await writeFile(join(root, ".env.local"), "")
    // Without node_modules a new database would fail, so returning false shows nothing ran.
    assert.equal(await ensureLocalDatabase(root, { log: () => undefined }), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installing again keeps the home's settings and its release for this database", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-home-"))
  try {
    const checkout = join(root, "checkout")
    const home = join(root, "home")
    await mkdir(join(checkout, ".convex", "local", "default"), { recursive: true })
    await writeFile(
      join(checkout, ".convex", "local", "default", "config.json"),
      JSON.stringify({ ports: { cloud: 4100, site: 4101 } })
    )
    git(checkout, "init", "-q", "-b", "main")
    git(checkout, "remote", "add", "origin", "git@github.com:someone/Blitz.git")
    git(checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "start")

    // A home set up earlier to follow another branch, already serving a release.
    const release = join(home, "releases", "abc")
    await mkdir(release, { recursive: true })
    await writeFile(
      join(release, ".blitz-release.json"),
      JSON.stringify({ commit: "a".repeat(40), id: "abc", builtAt: "t", convexUrl: "http://127.0.0.1:4100" })
    )
    await symlink(release, join(home, "current"))
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ repository: "https://example.com/fork.git", branch: "beta", sharedRoot: checkout })
    )
    git(root, "clone", "-q", "--bare", checkout, join(home, "repo.git"))

    const current = await setUpHome({ home, checkout, sharedRoot: checkout, log: () => undefined })
    assert.equal(current.directory, release)
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"))
    assert.deepEqual(config, { repository: "https://example.com/fork.git", branch: "beta", sharedRoot: checkout })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
