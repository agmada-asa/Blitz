/**
 * Verifies production releases and automatic updates: building releases from a
 * real temporary Git repository, the updater's switch-over order and failure
 * handling, and the supervisor's production mode, relocation, and database guard.
 */

import assert from "node:assert/strict"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, readlinkSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AutoUpdater, requestUpdate, waitForCheck } from "../electron/auto-update.mjs"
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
import { processGroupExists, processStartTime } from "../scripts/process-groups.mjs"

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

test("a failed command names its first error, not the warnings after it", async () => {
  await assert.rejects(
    runCommand(
      "sh",
      ["-c", 'echo "compiling"; echo "x.ts(1,1): error TS2322: bad" >&2; echo "warning: later"; exit 2'],
      { label: "next build" }
    ),
    (error: Error) =>
      error.message.split("\n")[0] ===
      "next build exited with 2: x.ts(1,1): error TS2322: bad"
  )
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
  const services: Record<string, unknown> & { cwd: string } = {
    port: 4007,
    cwd: current.directory,
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
      services.cwd = directory
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
  return { updater, steps, services }
}

/** Reads the state the updater wrote. */
async function readState(home: string) {
  return JSON.parse(await readFile(join(home, "run", "state.json"), "utf8"))
}

test("a push that fails after the backend may have taken it restores the old functions", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps } = updaterFixture(home, {
      pushConvexFunctions: async (directory: string) => {
        steps.push(`push ${directory}`)
        if (directory === "/releases/b") throw new Error("The Convex function push was stopped (SIGKILL).")
      },
    })
    const result = await updater.check()
    assert.equal(result.status, "failed")
    assert.deepEqual(steps.slice(-3), ["push /releases/b", "push /releases/a", "remove /releases/b"])
    assert.equal((await readState(home)).release.commit, "a".repeat(40))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("when the old functions cannot be pushed back, the old release restarts to push them", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps, services } = updaterFixture(home, {
      pushConvexFunctions: async (directory: string) => {
        steps.push(`push ${directory}`)
        throw new Error("timed out")
      },
    })
    assert.equal((await updater.check()).status, "failed")
    assert.deepEqual(steps.slice(-4), [
      "push /releases/b",
      "push /releases/a",
      "relocate /releases/a",
      "remove /releases/b",
    ])
    assert.equal(services.cwd, "/releases/a")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("a failed activation moves the services back, so what runs matches what is recorded", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const { updater, steps, services } = updaterFixture(home, {
      activate: async () => {
        throw new Error("EACCES: permission denied, rename")
      },
    })
    const result = await updater.check()
    assert.equal(result.status, "failed")
    assert.match(result.message, /still running aaaaaaa/)
    assert.deepEqual(steps.slice(-3), ["relocate /releases/b", "relocate /releases/a", "remove /releases/b"])
    assert.equal(services.cwd, "/releases/a")
    assert.equal((await readState(home)).release.commit, "a".repeat(40))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("when the old release will not start again, the new one is kept and recorded", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    const fixture = updaterFixture(home, {
      activate: async () => {
        throw new Error("EACCES: permission denied, rename")
      },
      services: {
        relocate: async (directory: string) => {
          fixture.steps.push(`relocate ${directory}`)
          // Going back fails, and the supervisor starts the new release again.
          if (directory === "/releases/a") throw new Error("Blitz did not become healthy: timeout")
          fixture.services.cwd = directory
        },
      },
    })
    const result = await fixture.updater.check()
    assert.equal(result.status, "failed")
    assert.equal(fixture.services.cwd, "/releases/b")
    assert.ok(!fixture.steps.includes("remove /releases/b"))
    assert.equal((await readState(home)).release.commit, "b".repeat(40))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("a rebuild asked for during a check runs after it and gets its own answer", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    let releaseFetch = () => undefined as unknown
    const { updater, steps } = updaterFixture(home, {
      fetchTarget: () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve("a".repeat(40))
        }),
    })
    const scheduled = updater.check({ reason: "scheduled" })
    const rebuild = updater.check({ rebuild: true, reason: "manual", requestId: "r1" })
    const plain = updater.check({ reason: "manual", requestId: "r2" })
    assert.notEqual(scheduled, rebuild)
    assert.equal(rebuild, plain, "a check asked for while a rebuild waits joins the rebuild")
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFetch()
    assert.equal((await scheduled).status, "up-to-date")
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFetch()
    assert.equal((await rebuild).status, "updated")
    assert.equal(steps[0], "build")
    const answers = (await readState(home)).answers
    assert.equal(answers.r1.status, "updated")
    assert.equal(answers.r2.status, "updated")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("requests sent while the server starts wait for it instead of ending it", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  const listeners = process.listeners("SIGUSR2")
  // The test runner writes a diagnostic report on SIGUSR2; Blitz's server does not.
  const reportOnSignal = process.report.reportOnSignal
  process.report.reportOnSignal = false
  try {
    const { updater, steps } = updaterFixture(home)
    // As the launcher does: listen before the state names this process.
    updater.listenForRequests()
    await updater.writeState()
    const rebuildId = await requestUpdate(home, "rebuild")
    const checkId = await requestUpdate(home, "check")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(steps, [], "nothing runs before start")
    assert.equal(updater.waitingRequests.length, 2)

    updater.start()
    const [rebuilt, checked] = await Promise.all([
      waitForCheck(home, rebuildId, { pollMs: 5, timeoutMs: 5_000 }),
      waitForCheck(home, checkId, { pollMs: 5, timeoutMs: 5_000 }),
    ])
    updater.stop()
    assert.equal(rebuilt.status, "updated")
    assert.ok(["updated", "up-to-date"].includes(checked.status))
  } finally {
    process.report.reportOnSignal = reportOnSignal
    for (const listener of process.listeners("SIGUSR2"))
      if (!listeners.includes(listener)) process.off("SIGUSR2", listener)
    await rm(home, { recursive: true, force: true })
  }
})

test("a request to a process that only reused the server's ID is refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "blitz-update-"))
  try {
    await mkdir(join(home, "run"), { recursive: true })
    await writeFile(
      join(home, "run", "state.json"),
      JSON.stringify({ pid: process.pid, processStartedAt: "Thu Jan  1 00:00:00 1970" })
    )
    await assert.rejects(requestUpdate(home, "check"), /not running/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

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
      child.once("exit", () => byPid.delete(child.pid))
      children.push(child)
      byPid.set(child.pid, child)
      return child
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    healthIntervalMs: 1,
    shutdownGraceMs: 5,
    killProcess: (pid: number, signal?: string | number) => {
      // A group lives until its child exits; signal 0 only checks that.
      const child = byPid.get(Math.abs(pid))
      if (!child) throw Object.assign(new Error("No such process"), { code: "ESRCH" })
      if (signal !== 0) child.emit("exit", 0, null)
      return true
    },
    ...options,
  })
  return { manager, children }
}

test("stopping a service waits for its whole group, not just the first process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  try {
    // The leader exits on SIGTERM, but a descendant keeps the group alive until SIGKILL.
    const survivors = new Set<number>()
    const signals: string[] = []
    const harness = productionHarness(cwd, {
      killProcess: (pid: number, signal?: string | number) => {
        const group = Math.abs(pid)
        const child = harness.children.find((candidate) => candidate.pid === group)
        if (!child || !survivors.has(group)) throw Object.assign(new Error("gone"), { code: "ESRCH" })
        if (signal === 0) return true
        signals.push(`${group} ${signal}`)
        child.emit("exit", 0, null)
        if (signal === "SIGKILL") survivors.delete(group)
        return true
      },
    })
    const { manager, children } = harness
    const spawn = manager.spawnProcess
    manager.spawnProcess = (command: string, args: string[], options: object) => {
      const child = spawn(command, args, options)
      survivors.add(child.pid as number)
      return child
    }
    await manager.start()
    await manager.stop()
    for (const child of children) {
      assert.ok(signals.includes(`${child.pid} SIGTERM`))
      assert.ok(signals.includes(`${child.pid} SIGKILL`), "the surviving group is killed")
    }
    assert.equal(survivors.size, 0)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("orphan cleanup stops recorded groups and spares a process that reused an ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-production-"))
  const sleepers: ChildProcess[] = []
  try {
    const start = () => {
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
      sleepers.push(child)
      return child.pid as number
    }
    const orphan = start()
    const stranger = start()
    const pidFile = join(cwd, "services.json")
    await writeFile(
      pidFile,
      JSON.stringify({
        next: { pid: orphan, startedAt: processStartTime(orphan) },
        // Recorded for an earlier process with the same ID.
        worker: { pid: stranger, startedAt: "Thu Jan  1 00:00:00 1970" },
      })
    )
    const manager = new ServiceManager({ cwd, production: true, pidFile, shutdownGraceMs: 500 })
    await manager.reapOrphans()
    assert.equal(processGroupExists(orphan), false)
    assert.equal(processGroupExists(stranger), true)
    assert.deepEqual(JSON.parse(await readFile(pidFile, "utf8")), {})

    // Builds and trial servers are recorded too, so the next launch can stop them.
    manager.trackGroup(stranger)
    assert.equal(JSON.parse(await readFile(pidFile, "utf8"))[`temporary:${stranger}`].pid, stranger)
    manager.untrackGroup(stranger)
    assert.deepEqual(JSON.parse(await readFile(pidFile, "utf8")), {})
  } finally {
    for (const child of sleepers) child.kill("SIGKILL")
    await rm(cwd, { recursive: true, force: true })
  }
})

test("release commands report their process groups while they run", async () => {
  const events: string[] = []
  await runCommand("true", [], {
    processes: {
      trackGroup: (pid: number) => events.push(`track ${pid}`),
      untrackGroup: (pid: number) => events.push(`untrack ${pid}`),
    },
  })
  assert.equal(events.length, 2)
  assert.equal(events[0].replace("track", "untrack"), events[1])
})

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
