/**
 * Verifies production releases and automatic updates: building releases from a
 * real temporary Git repository, the updater's switch-over order and failure
 * handling, and the supervisor's production mode, relocation, and database guard.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, readlinkSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AutoUpdater } from "../electron/auto-update.mjs"
import {
  currentRelease,
  RELEASE_MARKER,
  ReleaseManager,
  runCommand,
} from "../electron/release-manager.mjs"
import {
  DatabaseInUseError,
  ServiceManager,
} from "../electron/service-manager.mjs"

/** Runs Git in a directory for fixture setup. */
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** Commits files to the fixture's source repository and returns the commit. */
async function commit(source: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true })
    await writeFile(join(source, name), content)
  }
  git(source, "add", "-A")
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "change")
  return git(source, "rev-parse", "HEAD")
}

/**
 * Creates a source repository, a bare release repository cloned from it, a
 * shared checkout with settings, and a release manager whose only fakes are
 * the slow steps: npm, `next build`, and the `node_modules` clone.
 */
async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "blitz-releases-"))
  const source = join(root, "source")
  const shared = join(root, "shared")
  const home = join(root, "home")
  await mkdir(source)
  await mkdir(join(shared, ".convex", "local", "default"), { recursive: true })
  await writeFile(join(shared, ".env.local"), "CONVEX_DEPLOYMENT=local\n")
  git(source, "init", "-q", "-b", "main")
  const first = await commit(source, {
    [RELEASE_MARKER]: "// runner\n",
    "package-lock.json": "{}\n",
  })
  await mkdir(home)
  git(root, "clone", "-q", "--bare", source, join(home, "repo.git"))
  const calls: string[] = []
  const manager = new ReleaseManager({
    home,
    config: { repository: source, branch: "main", sharedRoot: shared },
    run: async (command, args, options = {}) => {
      if (command === "git") return runCommand(command, args, options)
      calls.push([command, ...args].join(" "))
      // Stand-ins for npm ci and the node_modules clone.
      if (args.includes("ci") || command === "cp")
        await mkdir(join(options.cwd ?? args.at(-1) ?? "", "node_modules"), { recursive: true })
      return ""
    },
  })
  return { root, source, shared, home, first, manager, calls }
}

test("builds a release from the tracked branch with the shared settings linked", async () => {
  const { root, source, shared, home, first, manager, calls } = await releaseFixture()
  try {
    assert.equal(await manager.fetchTarget(), first)
    assert.equal(await manager.canServe(first), true)
    const built = await manager.build(first, { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:4100" })
    assert.equal(readlinkSync(join(built.directory, ".env.local")), join(shared, ".env.local"))
    assert.equal(readlinkSync(join(built.directory, ".convex")), join(shared, ".convex"))
    assert.ok(calls.some((call) => call.startsWith("nice -n 10 npm ci")))
    assert.ok(calls.some((call) => call.endsWith("next build")))
    await manager.activate(built.directory)
    const current = await currentRelease(home)
    assert.equal(current?.commit, first)
    assert.equal(current?.convexUrl, "http://127.0.0.1:4100")

    // A later commit with the same lockfile clones the dependencies instead of installing.
    const second = await commit(source, { "README.md": "next\n" })
    assert.equal(await manager.fetchTarget(), second)
    calls.length = 0
    await manager.build(second, { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:4100" })
    assert.ok(calls.some((call) => call.startsWith("cp -cR")))
    assert.ok(!calls.some((call) => call.includes("npm ci")))

    // A commit without the runner could not update itself, so it is not served.
    git(source, "rm", "-q", RELEASE_MARKER)
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "drop")
    assert.equal(await manager.canServe(await manager.fetchTarget()), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed build is removed and keeps its log", async () => {
  const { root, first, manager } = await releaseFixture()
  try {
    const failing = new ReleaseManager({
      home: manager.home,
      config: manager.config,
      run: async (command, args, options = {}) => {
        if (command === "git") return runCommand(command, args, options)
        if (args.at(-1) === "build") throw new Error("next build exited with 1:\nType error")
        await mkdir(join(options.cwd ?? "", "node_modules"), { recursive: true })
        return ""
      },
    })
    await failing.fetchTarget()
    await assert.rejects(
      failing.build(first, { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:4100" }),
      (error: Error & { logPath?: string }) =>
        error.message === "Could not build the app: next build exited with 1:" &&
        Boolean(error.logPath && existsSync(error.logPath))
    )
    assert.deepEqual(await failing.listReleases(), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("pruning keeps the served release and the newest builds", async () => {
  const { root, source, home, first, manager } = await releaseFixture()
  try {
    await manager.fetchTarget()
    const served = await manager.build(first, { NEXT_PUBLIC_CONVEX_URL: "u" })
    await manager.activate(served.directory)
    for (let index = 0; index < 4; index += 1) {
      const next = await commit(source, { [`file-${index}`]: String(index) })
      await manager.fetchTarget()
      await manager.build(next, { NEXT_PUBLIC_CONVEX_URL: "u" })
    }
    await manager.prune()
    const kept = await manager.listReleases()
    assert.equal(kept.length, 4)
    assert.ok(kept.some((release) => release.directory === served.directory))
    assert.equal((await currentRelease(home))?.directory, served.directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** An updater wired to recording fakes; each step can be made to fail. */
function updaterFixture(home: string, overrides: Record<string, unknown> = {}) {
  const steps: string[] = []
  const current = { commit: "a".repeat(40), id: "a", builtAt: "t0", directory: "/releases/a" }
  const releases = {
    config: { branch: "main" },
    fetchTarget: async () => "b".repeat(40),
    canServe: async () => true,
    build: async (target: string) => {
      steps.push("build")
      return { commit: target, id: "b", builtAt: "t1", directory: "/releases/b", logPath: "/logs/b" }
    },
    pushConvexFunctions: async (directory: string) => {
      steps.push(`push ${directory}`)
    },
    activate: async (directory: string) => {
      steps.push(`activate ${directory}`)
    },
    remove: async (directory: string) => {
      steps.push(`remove ${directory}`)
    },
    prune: async () => {
      steps.push("prune")
    },
    ...overrides,
  }
  const services = {
    port: 4007,
    environment: { BLITZ_CONVEX_URL: "http://127.0.0.1:4100" },
    prepareEnvironment: async () => ({
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:4100",
      NEXT_PUBLIC_CONVEX_SITE_URL: "http://127.0.0.1:4101",
    }),
    probe: async (directory: string) => {
      steps.push(`probe ${directory}`)
    },
    relocate: async (directory: string) => {
      steps.push(`relocate ${directory}`)
    },
    ...((overrides.services as object) ?? {}),
  }
  let busyChecks = Number(overrides.busyChecks ?? 0)
  const updater = new AutoUpdater({
    releases: releases as never,
    services: services as never,
    home,
    host: "server",
    idlePollMs: 1,
    log: () => undefined,
    fetchImpl: (async () => {
      steps.push("idle?")
      return { json: async () => ({ activeChatRuns: busyChecks-- > 0 ? 1 : 0 }) }
    }) as never,
  })
  updater.recordRelease(current)
  return { updater, steps }
}

test("an update builds, tries, waits for replies, pushes, then switches", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps } = updaterFixture(home, { busyChecks: 2 })
    const result = await updater.check({ reason: "manual" })
    assert.equal(result.status, "updated")
    assert.deepEqual(steps, [
      "build",
      "probe /releases/b",
      "idle?",
      "idle?",
      "idle?",
      "push /releases/b",
      "relocate /releases/b",
      "activate /releases/b",
      "prune",
    ])
    const state = JSON.parse(await readFile(join(home, "run", "state.json"), "utf8"))
    assert.equal(state.release.commit, "b".repeat(40))
    assert.equal(state.failure, null)
    assert.equal(state.lastCheck.status, "updated")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("a failed switch restores the old functions and is not retried until asked", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps } = updaterFixture(home, {
      services: {
        relocate: async () => {
          throw new Error("Blitz did not become healthy: timeout")
        },
      },
    })
    const failed = await updater.check({ reason: "scheduled" })
    assert.equal(failed.status, "failed")
    assert.equal(failed.logPath, "/logs/b")
    assert.match(failed.message, /still running aaaaaaa/)
    assert.ok(steps.includes("push /releases/a"))
    assert.ok(steps.includes("remove /releases/b"))
    assert.ok(!steps.some((step) => step.startsWith("activate")))

    steps.length = 0
    const repeated = await updater.check({ reason: "scheduled" })
    assert.equal(repeated.status, "failed")
    assert.deepEqual(steps, [])

    await updater.check({ rebuild: true, reason: "manual" })
    assert.equal(steps[0], "build")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("a build failure leaves the running release alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps } = updaterFixture(home, {
      build: async () => {
        throw Object.assign(new Error("Could not build the app: next build exited with 1"), {
          logPath: "/logs/b",
        })
      },
    })
    const result = await updater.check()
    assert.equal(result.status, "failed")
    assert.match(result.message, /could not build bbbbbbb/)
    assert.deepEqual(steps, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("stays on the current release when it is newest or the branch lacks the runner", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const upToDate = updaterFixture(home, { fetchTarget: async () => "a".repeat(40) })
    assert.equal((await upToDate.updater.check()).status, "up-to-date")
    const old = updaterFixture(home, { canServe: async () => false })
    const skipped = await old.updater.check()
    assert.equal(skipped.status, "skipped")
    assert.deepEqual(old.steps, [])
    const offline = updaterFixture(home, {
      fetchTarget: async () => {
        throw new Error("Could not resolve host")
      },
    })
    assert.equal((await offline.updater.check()).status, "offline")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/** Child-process double for supervisor tests. */
type FakeChild = EventEmitter & { pid: number; command: string; args: string[]; cwd: string }

/** A production supervisor wired to fake processes. */
function productionHarness(cwd: string, options: Record<string, unknown> = {}) {
  const children: FakeChild[] = []
  const byPid = new Map<number, FakeChild>()
  const manager = new ServiceManager({
    cwd,
    port: 43211,
    production: true,
    spawnProcess: (command: string, args: string[], spawnOptions: object) => {
      const child = new EventEmitter() as FakeChild
      child.pid = 1000 + children.length
      child.command = command
      child.args = args
      child.cwd = (spawnOptions as { cwd: string }).cwd
      children.push(child)
      byPid.set(child.pid, child)
      return child
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    healthIntervalMs: 1,
    shutdownGraceMs: 5,
    killProcess: (pid: number) => byPid.get(Math.abs(pid))?.emit("exit", 0, null),
    ...options,
  })
  return { manager, children }
}

test("production mode runs next start and skips workers the release lacks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  try {
    const { manager, children } = productionHarness(cwd)
    await manager.start()
    const [convex, next] = children
    assert.equal(convex.command, "node")
    assert.ok(convex.args.includes("--codegen") && convex.args.includes("--typecheck"))
    assert.deepEqual(next.args.slice(1, 2), ["start"])
    assert.equal(children.length, 2, "scripts/worker.ts is missing from the release")
    assert.equal(manager.environment?.BLITZ_NEXT_DIST_DIR, undefined)
    await manager.stop()

    await mkdir(join(cwd, "scripts"))
    await writeFile(join(cwd, "scripts", "worker.ts"), "")
    const withWorker = productionHarness(cwd)
    await withWorker.manager.start()
    assert.equal(withWorker.children.length, 3)
    await withWorker.manager.stop()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("relocating restarts every service from the new release without restart loops", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  try {
    const { manager, children } = productionHarness(cwd, { restartBaseDelayMs: 1 })
    await manager.start()
    await manager.relocate("/releases/new")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(children.length, 4)
    assert.deepEqual(
      children.slice(2).map((child) => child.cwd),
      ["/releases/new", "/releases/new"]
    )
    assert.equal(manager.snapshot().next.restarts, 0)
    await manager.stop()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("relocating back when the new release does not answer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  try {
    const broken = "/releases/broken"
    const harness = productionHarness(cwd, {
      healthTimeoutMs: 30,
      // Nothing answers while the supervisor serves the broken release.
      fetchImpl: async () => {
        if (harness.manager.cwd === broken) throw new Error("refused")
        return { ok: true, status: 200 }
      },
    })
    const { manager, children } = harness
    await manager.start()
    await assert.rejects(manager.relocate(broken), /did not become healthy/)
    assert.equal(manager.cwd, cwd)
    assert.equal(children.at(-1)?.cwd, cwd)
    await manager.stop()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("refuses to open a database another Blitz is serving", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  try {
    await mkdir(join(cwd, ".convex", "local", "default"), { recursive: true })
    await writeFile(
      join(cwd, ".convex", "local", "default", "config.json"),
      JSON.stringify({ ports: { cloud: 4300, site: 4301 }, deploymentName: "local-blitz" })
    )
    const answering = (name: string) => async () => ({
      ok: true,
      status: 200,
      text: async () => name,
    })
    const busy = productionHarness(cwd, { fetchImpl: answering("local-blitz") })
    await assert.rejects(busy.manager.prepareEnvironment(), DatabaseInUseError)
    const other = productionHarness(cwd, { fetchImpl: answering("someone-else") })
    const environment = await other.manager.prepareEnvironment()
    assert.equal(environment.BLITZ_CONVEX_URL, "http://127.0.0.1:4300")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
