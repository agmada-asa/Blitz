/** Verifies local service supervision, restart backoff, and shutdown with in-memory child processes. */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parseLoginEnvironment } from "../electron/login-environment.mjs"
import {
  findRunningStack,
  resolveLocalConvexPorts,
  ServiceManager,
} from "../electron/service-manager.mjs"

test("the login environment ignores startup output and shell bookkeeping", () => {
  assert.deepEqual(
    parseLoginEnvironment(
      "Welcome back\n__BLITZ_ENVIRONMENT__PATH=/a:/b\0NOTE=x=y\0SHLVL=2\0_=/usr/bin/env\0"
    ),
    { PATH: "/a:/b", NOTE: "x=y" }
  )
  assert.deepEqual(parseLoginEnvironment("PATH=/a\0"), {})
})

test("a running stack needs both Convex and Next to answer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "blitz-stack-"))
  try {
    /** Answers only the listed URLs, as a real loopback probe would. */
    const answering = (...urls: string[]) => async (url: string) => {
      if (!urls.includes(url)) throw new Error("refused")
      return { ok: true, status: 200 }
    }
    const convex = "http://127.0.0.1:4100"
    const lan = "http://127.0.0.1:4007/api/health"
    const desktop = "http://127.0.0.1:4008/api/health"
    const ports = [4007, 4008]

    assert.equal(await findRunningStack(cwd, ports, answering(convex, lan)), undefined)

    await mkdir(join(cwd, ".convex", "local", "default"), { recursive: true })
    await writeFile(
      join(cwd, ".convex", "local", "default", "config.json"),
      JSON.stringify({ ports: { cloud: 4100, site: 4101 } })
    )
    assert.equal(await findRunningStack(cwd, ports, answering(lan)), undefined)
    assert.equal(await findRunningStack(cwd, ports, answering(convex)), undefined)
    assert.deepEqual(await findRunningStack(cwd, ports, answering(convex, desktop)), {
      port: 4008,
      convexUrl: convex,
    })
    assert.deepEqual(await findRunningStack(cwd, ports, answering(convex, lan, desktop)), {
      port: 4007,
      convexUrl: convex,
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

/** Child-process double that records its spawn command. */
type FakeChild = EventEmitter & {
  pid: number
  command: string
  args: string[]
  kill: () => void
}

/** Builds a manager wired to fake processes, plus helpers to drive them. */
function harness(options: Record<string, unknown> = {}) {
  const children: FakeChild[] = []
  const byPid = new Map<number, FakeChild>()
  const healthUrls: string[] = []
  const statusEvents: Array<[string, string]> = []
  const manager = new ServiceManager({
    cwd: process.cwd(),
    port: 43210,
    spawnProcess: (command: string, args: string[]) => {
      const child = new EventEmitter() as FakeChild
      child.pid = children.length + 1
      child.command = command
      child.args = args
      child.kill = () => child.emit("exit", 0, null)
      child.once("exit", () => byPid.delete(child.pid))
      children.push(child)
      byPid.set(child.pid, child)
      return child
    },
    fetchImpl: async (url: string) => {
      healthUrls.push(url)
      return { ok: true, status: 200 }
    },
    restartBaseDelayMs: 2,
    restartMaxDelayMs: 8,
    healthIntervalMs: 1,
    shutdownGraceMs: 5,
    killProcess: (pid: number, signal?: string | number) => {
      // A group lives until its child exits; signal 0 only checks that.
      const child = byPid.get(Math.abs(pid))
      if (!child) throw Object.assign(new Error("No such process"), { code: "ESRCH" })
      if (signal !== 0) child.emit("exit", 0, null)
      return true
    },
    onStatus: (name: string, status: { state: string }) =>
      statusEvents.push([name, status.state]),
    ...options,
  })
  /** Returns the newest child spawned for a service: `next dev` or the worker script. */
  const latest = (service: "next" | "worker") =>
    children.findLast((child) =>
      service === "next"
        ? child.args[0]?.endsWith(join("next", "dist", "bin", "next")) && child.args[1] === "dev"
        : child.args.includes("scripts/worker.ts")
    )
  return { manager, children, healthUrls, statusEvents, latest }
}

/** Waits long enough for millisecond restart timers to fire. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test("starts Convex and Next, checks both, then starts voice and background workers", async () => {
  const { manager, children, healthUrls } = harness()
  const convexPorts = await resolveLocalConvexPorts(process.cwd())
  await manager.start()
  assert.equal(children.length, 4)
  assert.deepEqual(children[2].args, ["--experimental-strip-types", "scripts/voice-service.ts"])
  assert.deepEqual(children[3].args, [
    "--experimental-strip-types",
    "scripts/worker.ts",
  ])
  assert.equal(children[0].command, "npx")
  assert.deepEqual(children[0].args.slice(-4), [
    "--local-cloud-port",
    String(convexPorts.cloud),
    "--local-site-port",
    String(convexPorts.site),
  ])
  assert.ok(healthUrls.includes(`http://127.0.0.1:${convexPorts.cloud}`))
  assert.equal(manager.snapshot().next.state, "ready")
  assert.equal(manager.snapshot().convex.state, "ready")
  assert.equal(manager.snapshot().worker.state, "running")
  assert.equal(manager.snapshot().voice.state, "running")
  await manager.stop()
})

test("keeps restarting a crashing worker without stopping other services", async () => {
  const { manager, latest } = harness()
  await manager.start()
  for (let crash = 0; crash < 4; crash += 1) {
    latest("worker")?.emit("exit", 1, null)
    assert.equal(manager.snapshot().worker.state, "restarting")
    await settle()
  }
  const status = manager.snapshot()
  assert.equal(status.worker.state, "running")
  assert.equal(status.worker.restarts, 4)
  assert.equal(status.worker.lastExit, "1")
  assert.equal(status.next.state, "ready")
  assert.equal(status.convex.state, "ready")
  await manager.stop()
})

test("restarts Next and Convex instead of shutting the stack down", async () => {
  const { manager, latest, children } = harness()
  await manager.start()
  children[0].emit("exit", null, "SIGKILL")
  latest("next")?.emit("exit", 1, null)
  await settle()
  const status = manager.snapshot()
  assert.equal(status.convex.state, "running")
  assert.equal(status.convex.lastExit, "SIGKILL")
  assert.equal(status.next.state, "running")
  assert.equal(status.worker.state, "running")
  await manager.stop()
})

test("grows the restart delay for quick crashes and caps it", async () => {
  const { manager, latest } = harness({
    restartBaseDelayMs: 1_000,
    restartMaxDelayMs: 4_000,
  })
  await manager.start()
  const delays: number[] = []
  for (let crash = 0; crash < 4; crash += 1) {
    const before = Date.now()
    latest("worker")?.emit("exit", 1, null)
    const { nextRestartAt } = manager.snapshot().worker
    delays.push(Math.round(((nextRestartAt ?? 0) - before) / 1_000))
    // Start the next attempt immediately rather than waiting for the timer.
    manager.restartTimers.forEach((timer: NodeJS.Timeout) =>
      clearTimeout(timer)
    )
    manager.startService("worker")
  }
  assert.deepEqual(delays, [1, 2, 4, 4])
  await manager.stop()
})

test("resets the backoff after a service stays up", async () => {
  const { manager, latest } = harness({
    restartBaseDelayMs: 1_000,
    restartMaxDelayMs: 30_000,
    stableUptimeMs: 0,
  })
  await manager.start()
  for (let crash = 0; crash < 3; crash += 1) {
    const before = Date.now()
    latest("worker")?.emit("exit", 1, null)
    const { nextRestartAt } = manager.snapshot().worker
    assert.equal(Math.round(((nextRestartAt ?? 0) - before) / 1_000), 1)
    manager.restartTimers.forEach((timer: NodeJS.Timeout) =>
      clearTimeout(timer)
    )
    manager.startService("worker")
  }
  await manager.stop()
})

test("stops every service and cancels pending restarts", async () => {
  const { manager, latest, children } = harness({ restartBaseDelayMs: 50 })
  await manager.start()
  latest("worker")?.emit("exit", 1, null)
  await manager.stop()
  const spawned = children.length
  await settle(80)
  assert.equal(children.length, spawned)
  const states = Object.values(manager.snapshot()).map(
    (status) => (status as { state: string }).state
  )
  assert.equal(states.length, 4)
  assert.ok(states.every((state) => state === "stopped"))
})

test("reports state transitions to the launcher", async () => {
  const { manager, latest, statusEvents } = harness()
  await manager.start()
  latest("worker")?.emit("exit", 1, null)
  await settle()
  const worker = statusEvents
    .filter(([name]) => name === "worker")
    .map(([, state]) => state)
  assert.deepEqual(worker, ["running", "restarting", "running"])
  await manager.stop()
})

test("restarts Convex when it stops answering while its process stays alive", async () => {
  let convexHealthy = true
  const { manager, children } = harness({
    livenessIntervalMs: 2,
    livenessGraceMs: 0,
    livenessFailureLimit: 2,
    fetchImpl: async (url: string) => {
      if (!url.endsWith("/api/health") && !convexHealthy) throw new Error("refused")
      return { ok: true, status: 200 }
    },
  })
  await manager.start()
  const firstConvex = children[0]
  convexHealthy = false
  await settle(60)
  convexHealthy = true
  const status = manager.snapshot().convex
  assert.equal(status.lastExit, "unresponsive")
  assert.ok(status.restarts >= 1)
  const convexSpawns = children.filter((child) => child.command === "npx")
  assert.ok(convexSpawns.length >= 2)
  assert.notEqual(convexSpawns.at(-1), firstConvex)
  assert.equal(manager.snapshot().next.restarts, 0)
  await manager.stop()
})
