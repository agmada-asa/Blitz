/**
 * Supervises Blitz's local Next, Convex, and worker processes for the desktop
 * app, `dev:lan`, and the background server.
 *
 * Two modes share one supervisor. Development mode runs `next dev` and
 * `convex dev` from a checkout, for coding sessions. Production mode runs
 * `next start` from a built directory (a release under `~/.blitz`, or a checkout
 * built by `buildCheckout`), whose memory stays flat because nothing recompiles.
 * `relocate` moves a production stack to a newer release in place.
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import {
  processGroupExists,
  processStartTime,
  terminateProcessGroups,
} from "../scripts/process-groups.mjs"

/** @typedef {import("node:events").EventEmitter & {pid?: number, kill?: (signal?: string) => void}} ManagedChild */
/** @typedef {(command: string, args: string[], options: object) => ManagedChild} SpawnProcess */
/** @typedef {(url: string, options?: object) => Promise<{ok: boolean, status: number, text?: () => Promise<string>, json?: () => Promise<unknown>}>} HealthFetch */
/** @typedef {(pid: number, signal?: string) => unknown} ProcessKiller */

/**
 * Background workers started after Next and Convex answer, as
 * `[service name, node arguments]` pairs. Source recovery and Deep Research run as
 * two isolated loops inside the one `worker` process (`scripts/worker.ts`), so
 * one failing loop backs off without stopping the other. The Kokoro speech
 * worker is started on demand by Next and is not supervised here. In
 * production mode a worker whose script the release does not contain is
 * skipped, so an older release still starts.
 */
const workerDefinitions = [
  ["voice", ["--experimental-strip-types", "scripts/voice-service.ts"]],
  ["worker", ["--experimental-strip-types", "scripts/worker.ts"]],
]

/** Next's CLI inside a project's own dependencies. */
const NEXT_CLI = join("node_modules", "next", "dist", "bin", "next")

/** Convex's CLI inside a project's own dependencies. */
const CONVEX_CLI = join("node_modules", "convex", "bin", "main.js")

/** Thrown when another Blitz stack already serves this database. */
export class DatabaseInUseError extends Error {
  /** @param {number} port The Convex port that answered. */
  constructor(port) {
    super(
      `Blitz's database is already running on port ${port}. Stop the other Blitz first; two servers on one database would corrupt it.`
    )
    this.name = "DatabaseInUseError"
    this.port = port
  }
}

/**
 * Reads the local Convex deployment saved by `convex dev`.
 * @param {string} cwd A directory containing `.convex/local/default/config.json`.
 * @returns {Promise<{ports?: {cloud?: number, site?: number}, deploymentName?: string, adminKey?: string} | undefined>}
 */
async function readLocalConvexConfig(cwd) {
  try {
    return JSON.parse(
      await readFile(
        join(cwd, ".convex", "local", "default", "config.json"),
        "utf8"
      )
    )
  } catch {
    return undefined
  }
}

/**
 * Reads the saved Blitz port pair, then checks upward by pairs when occupied.
 * @param {string} cwd Blitz's repository root containing the local Convex config.
 * @param {NodeJS.ProcessEnv} environment Optional port preferences for this launch.
 * @returns {Promise<{cloud: number, site: number}>} Ports reserved for Blitz startup.
 * @throws When no free pair is found before the bounded search ends.
 */
export async function resolveLocalConvexPorts(cwd, environment = process.env) {
  const { preferredCloudPort, preferredSitePort } = await preferredConvexPorts(
    cwd,
    environment
  )
  for (let offset = 0; offset <= 100; offset += 2) {
    const cloud = preferredCloudPort + offset
    const site = preferredSitePort + offset
    if (cloud > 65535 || site > 65535) break
    if ((await isPortAvailable(cloud)) && (await isPortAvailable(site))) {
      return { cloud, site }
    }
  }
  throw new Error("Could not find a free adjacent port pair for Blitz Convex.")
}

/**
 * Returns the saved or configured Convex port pair without checking it is free.
 * @param {string} cwd Blitz's repository root containing the local Convex config.
 * @param {NodeJS.ProcessEnv} environment Optional port preferences for this launch.
 * @throws When a configured port is not a valid unprivileged TCP port.
 */
async function preferredConvexPorts(cwd, environment) {
  const saved = await readLocalConvexConfig(cwd)
  // A fresh local deployment uses Blitz's dedicated pair instead of 3210/3211.
  const savedCloudPort = Number(saved?.ports?.cloud) || 3220
  const savedSitePort = Number(saved?.ports?.site) || 3221
  const preferredCloudPort =
    Number(environment.BLITZ_CONVEX_CLOUD_PORT) || savedCloudPort
  const preferredSitePort =
    Number(environment.BLITZ_CONVEX_SITE_PORT) || savedSitePort
  if (
    !Number.isInteger(preferredCloudPort) ||
    !Number.isInteger(preferredSitePort) ||
    preferredCloudPort < 1024 ||
    preferredSitePort < 1024 ||
    preferredCloudPort > 65535 ||
    preferredSitePort > 65535
  ) {
    throw new Error("Blitz Convex ports must be valid TCP ports above 1023.")
  }
  return { preferredCloudPort, preferredSitePort }
}

/**
 * Checks whether a loopback port is free and closes its temporary probe socket.
 * @param {number} port The local TCP port to check.
 * @returns {Promise<boolean>} Whether the port was available during the probe.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Asks the OS for a free loopback port, used to try a new release beside the live one.
 * @returns {Promise<number>} A port that was free a moment ago.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port."))
      )
    })
  })
}

/**
 * Finds a Blitz stack that is already up, such as the background server,
 * `npm run dev:lan`, or one left behind by a crashed desktop host. It owns the
 * local database, so a second stack could not start beside it.
 * @param {string} cwd Blitz's repository root containing the local Convex config.
 * @param {number[]} ports The Next ports to check, in order of preference.
 * @param {HealthFetch} [fetchImpl] Injectable fetch for tests.
 * @returns {Promise<{port: number, convexUrl: string} | undefined>} The stack, when Convex and Next both answer.
 */
export async function findRunningStack(
  cwd,
  ports,
  fetchImpl = globalThis.fetch
) {
  const saved = await readLocalConvexConfig(cwd)
  if (!saved?.ports?.cloud) return undefined
  const convexUrl = `http://127.0.0.1:${saved.ports.cloud}`
  const answers = (url) =>
    fetchImpl(url, { signal: AbortSignal.timeout(1_500) })
      .then((response) => response.status < 500)
      .catch(() => false)
  if (!(await answers(convexUrl))) return undefined
  for (const port of ports)
    if (await answers(`http://127.0.0.1:${port}/api/health`))
      return { port, convexUrl }
  return undefined
}

/**
 * Lists every process group with the command lines of its members.
 * @returns {Map<number, string[]>} Commands by process group ID; empty when `ps` fails.
 */
function listProcessGroups() {
  const groups = new Map()
  try {
    const output = execFileSync("ps", ["-A", "-o", "pgid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      if (!match) continue
      const group = Number(match[1])
      groups.set(group, [...(groups.get(group) ?? []), match[2]])
    }
  } catch {}
  return groups
}

/**
 * @typedef {"running" | "ready" | "restarting" | "stopped"} ServiceState
 * @typedef {{state: ServiceState, restarts: number, since: number, lastExit?: string, nextRestartAt?: number}} ServiceStatus
 */

/**
 * Supervises every local Blitz process and keeps the stack alive.
 *
 * Any service that exits unexpectedly is restarted with exponential backoff.
 * Convex and Next are also probed while running: `convex dev` keeps its
 * process alive when the database it hosts dies, so a service that stops
 * answering is killed and restarted like a crash.
 * The backoff resets once a process has stayed up for `stableUptimeMs`, so a
 * worker that crashes once a day restarts immediately while a crash loop
 * settles at `restartMaxDelayMs`. One failing service never stops the others;
 * only `stop()` ends the stack.
 */
export class ServiceManager {
  /**
   * Creates a stopped supervisor with the supplied repository and port settings.
   * `production` runs `next start` from an existing build in `cwd`; `distDir`
   * names that build when it is not `.next`. `pidFile` records the process
   * groups so a later launch can stop ones a killed launcher left behind.
   * @param {{cwd: string, port?: number, host?: string, desktop?: boolean, production?: boolean, distDir?: string, pidFile?: string, environment?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions, spawnProcess?: SpawnProcess, fetchImpl?: HealthFetch, killProcess?: ProcessKiller, restartBaseDelayMs?: number, restartMaxDelayMs?: number, stableUptimeMs?: number, healthIntervalMs?: number, healthTimeoutMs?: number, livenessIntervalMs?: number, livenessGraceMs?: number, livenessFailureLimit?: number, shutdownGraceMs?: number, onStatus?: (name: string, status: ServiceStatus) => void}} options
   */
  constructor({
    cwd,
    port = Number(process.env.BLITZ_PORT || 3008),
    host = process.env.BLITZ_DESKTOP_HOST || "127.0.0.1",
    desktop = true,
    production = false,
    distDir,
    pidFile,
    environment = process.env,
    stdio = "inherit",
    spawnProcess = spawn,
    fetchImpl = globalThis.fetch,
    killProcess = process.kill,
    restartBaseDelayMs = 500,
    restartMaxDelayMs = 30_000,
    stableUptimeMs = 60_000,
    healthIntervalMs = 250,
    healthTimeoutMs = Number(
      process.env.BLITZ_DESKTOP_HEALTH_TIMEOUT_MS || 60_000
    ),
    livenessIntervalMs = 5_000,
    livenessGraceMs = 30_000,
    livenessFailureLimit = 3,
    shutdownGraceMs = 5_000,
    onStatus = () => undefined,
  }) {
    this.cwd = cwd
    this.port = port
    this.host = host
    this.desktop = desktop
    this.production = production
    this.distDir = distDir
    this.pidFile = pidFile
    this.baseEnvironment = environment
    this.stdio = stdio
    /** @type {Map<string, ManagedChild>} */
    this.children = new Map()
    /** @type {Map<string, ServiceStatus>} */
    this.status = new Map()
    /** Consecutive quick failures per service, used for backoff. */
    this.attempts = new Map()
    /** Pending restart timers, cleared on shutdown. */
    this.restartTimers = new Map()
    /** Spawn time per service, used for backoff and the liveness grace period. */
    this.startedAt = new Map()
    /** Consecutive failed liveness probes per service. */
    this.livenessFailures = new Map()
    /** Exit reason to report instead of the signal when Blitz killed a service itself. */
    this.killReasons = new Map()
    /** Children stopped on purpose by `relocate`, which must not be restarted. */
    this.retired = new WeakSet()
    /**
     * Process groups by service name, mirrored to `pidFile`. Groups that are
     * not services, such as builds and trial servers, use `temporary:<pid>`.
     * @type {Record<string, {pid: number, startedAt?: string, match?: string}>}
     */
    this.recordedGroups = {}
    /** Process groups started by `trackGroup`, killed with the services by `killNow`. */
    this.temporaryGroups = new Set()
    this.stopping = false
    this.spawnProcess = spawnProcess
    this.fetchImpl = fetchImpl
    this.killProcess = killProcess
    this.restartBaseDelayMs = restartBaseDelayMs
    this.restartMaxDelayMs = restartMaxDelayMs
    this.stableUptimeMs = stableUptimeMs
    this.healthIntervalMs = healthIntervalMs
    this.healthTimeoutMs = healthTimeoutMs
    this.livenessIntervalMs = livenessIntervalMs
    this.livenessGraceMs = livenessGraceMs
    this.livenessFailureLimit = livenessFailureLimit
    this.shutdownGraceMs = shutdownGraceMs
    this.onStatus = onStatus
  }

  /**
   * Stops leftovers from a killed launcher, resolves ports, starts Convex and
   * Next, waits until both answer, then starts the worker so its first requests
   * do not fail.
   * @throws {DatabaseInUseError} When another Blitz stack serves the database.
   * @throws When Next or Convex does not become healthy before the timeout.
   */
  async start() {
    await this.reapOrphans()
    await this.prepareEnvironment()
    await this.launch({ stopOnFailure: true })
  }

  /**
   * Resolves the ports and the environment every service shares. Safe to call
   * before `start`, so a launcher can build for the Convex URL the browser
   * bundle needs. Later calls return the same environment.
   * @returns {Promise<NodeJS.ProcessEnv>} The services' environment.
   * @throws {DatabaseInUseError} When another Blitz stack serves the database.
   */
  async prepareEnvironment() {
    if (this.environment) return this.environment
    const base = this.baseEnvironment
    const skipConvex = base.BLITZ_DESKTOP_SKIP_CONVEX === "1"
    if (!skipConvex) await this.assertDatabaseFree()
    // Attaching to a running database must use its ports, which are taken.
    const convexPorts = skipConvex
      ? await preferredConvexPorts(this.cwd, base).then((ports) => ({
          cloud: ports.preferredCloudPort,
          site: ports.preferredSitePort,
        }))
      : await resolveLocalConvexPorts(this.cwd, base)
    // Browsers rewrite this loopback host to the page's own hostname, so the
    // same build works on this Mac, over LAN, and after a network change.
    /** @type {NodeJS.ProcessEnv} */
    const environment = {
      ...base,
      BLITZ_PORT: String(this.port),
      BLITZ_VOICE_PORT: base.BLITZ_VOICE_PORT || String(this.port + 100),
      BLITZ_SERVER_URL: `http://127.0.0.1:${this.port}`,
      BLITZ_CONVEX_URL: `http://127.0.0.1:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${convexPorts.site}`,
      ...(this.desktop ? { BLITZ_DESKTOP: "1" } : {}),
    }
    if (this.production) {
      // A production build is read from the directory it was built into.
      delete environment.BLITZ_NEXT_DIST_DIR
      if (this.distDir) environment.BLITZ_NEXT_DIST_DIR = this.distDir
    } else if (this.desktop) {
      environment.BLITZ_NEXT_DIST_DIR = base.BLITZ_NEXT_DIST_DIR || ".next-desktop"
    }
    this.environment = environment
    return environment
  }

  /**
   * Refuses to start a second Convex backend over a database that is already
   * served, which would corrupt it. The backend answers `/instance_name` with
   * the deployment name saved beside the database.
   * @throws {DatabaseInUseError} When the saved port answers with this deployment's name.
   */
  async assertDatabaseFree() {
    const saved = await readLocalConvexConfig(this.cwd)
    const port = Number(saved?.ports?.cloud)
    if (!port || !saved?.deploymentName) return
    let name
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/instance_name`,
        { signal: AbortSignal.timeout(1_500) }
      )
      if (response.ok && typeof response.text === "function")
        name = (await response.text()).trim()
    } catch {
      return
    }
    if (name === saved.deploymentName) throw new DatabaseInUseError(port)
  }

  /**
   * Defines and starts Convex and Next from `cwd`, waits for both, then starts
   * the workers.
   * @param {{stopOnFailure: boolean}} options Whether a failed health check stops the stack.
   * @throws When Next or Convex does not become healthy before the timeout.
   */
  async launch({ stopOnFailure }) {
    const base = this.baseEnvironment
    const environment = this.environment
    const convexPort = new URL(environment.BLITZ_CONVEX_URL).port
    const sitePort = new URL(environment.NEXT_PUBLIC_CONVEX_SITE_URL).port
    this.definitions = new Map()
    if (base.BLITZ_DESKTOP_SKIP_CONVEX !== "1") {
      const portArgs = ["--local-cloud-port", convexPort, "--local-site-port", sitePort]
      if (this.production)
        // A release never changes, so type checks and code generation would
        // only slow every start; `convex dev` still pushes the functions once.
        this.define("convex", "node", [
          CONVEX_CLI,
          "dev",
          "--tail-logs",
          "disable",
          "--typecheck",
          "disable",
          "--codegen",
          "disable",
          ...portArgs,
        ])
      else
        this.define("convex", "npx", [
          "convex",
          "dev",
          "--tail-logs",
          "disable",
          ...portArgs,
        ])
    }
    // Next runs directly in the group this supervisor records, not through a
    // launcher such as `scripts/dev.mjs` that would move it into a group of
    // its own, which orphan cleanup after a crash could not find.
    this.define("next", "node", [
      NEXT_CLI,
      this.production ? "start" : "dev",
      "--hostname",
      this.host,
      "--port",
      String(this.port),
    ])
    for (const name of this.definitions.keys()) this.startService(name)
    await this.waitForHealth({ stopOnFailure })
    clearInterval(this.livenessTimer)
    this.livenessTimer = setInterval(
      () => void this.checkLiveness(),
      this.livenessIntervalMs
    )
    this.livenessTimer.unref?.()
    if (base.BLITZ_DESKTOP_SKIP_WORKERS !== "1")
      for (const [name, args] of workerDefinitions) {
        if (this.production && !existsSync(join(this.cwd, args.at(-1)))) continue
        this.define(name, "node", args)
        this.startService(name)
      }
  }

  /**
   * Moves a running production stack to another built directory: every
   * service stops and starts again from `directory`, so Convex pushes that
   * release's functions and nothing keeps running from the old folder. If the
   * new stack does not become healthy, the old directory is started again.
   * @param {string} directory The release to serve.
   * @throws When the new release does not become healthy; the old one is running again.
   */
  async relocate(directory) {
    const previous = this.cwd
    await this.pause()
    this.cwd = directory
    try {
      await this.launch({ stopOnFailure: false })
    } catch (error) {
      await this.pause()
      this.cwd = previous
      // Best effort: if this fails too, the supervisor keeps restarting with backoff.
      await this.launch({ stopOnFailure: false }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Starts a built directory's Next server on a spare loopback port and checks
   * that it serves its health route and the home page, then stops it. The live
   * server is not touched, so a release that crashes on start is never switched to.
   * @param {string} directory The release to try.
   * @param {{timeoutMs?: number}} [options] How long the server may take to answer.
   * @throws When the trial server does not answer in time.
   */
  async probe(directory, { timeoutMs = 60_000 } = {}) {
    const port = await findFreePort()
    const child = this.spawnProcess(
      "node",
      [NEXT_CLI, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: directory,
        env: this.environment,
        stdio: this.stdio,
        detached: process.platform !== "win32",
      }
    )
    // Recorded so a launcher killed during the trial does not leave it running.
    if (child.pid) this.trackGroup(child.pid)
    let exited = false
    child.once("exit", () => {
      exited = true
    })
    const deadline = Date.now() + timeoutMs
    let lastError = "no answer"
    try {
      for (const path of ["/api/health", "/"]) {
        for (;;) {
          if (exited) throw new Error("The new version stopped while starting.")
          if (Date.now() > deadline)
            throw new Error(`The new version did not answer ${path}: ${lastError}.`)
          try {
            const response = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
              signal: AbortSignal.timeout(10_000),
            })
            if (response.ok) break
            lastError = `HTTP ${response.status}`
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
          }
          await new Promise((resolve) => setTimeout(resolve, this.healthIntervalMs))
        }
      }
    } finally {
      await this.stopChild(child)
      if (child.pid) this.untrackGroup(child.pid)
    }
  }

  /**
   * Records a process group that is not a service, such as a release build or
   * a trial server, so `killNow` and a later launch's `reapOrphans` stop it if
   * this launcher dies first. `ReleaseManager` calls this for every command it runs.
   * @param {number} pid The group's leader, started with `detached: true`.
   */
  trackGroup(pid) {
    this.temporaryGroups.add(pid)
    this.recordGroup(`temporary:${pid}`, pid)
  }

  /**
   * Forgets a group from `trackGroup` once it has ended.
   * @param {number} pid The group's leader.
   */
  untrackGroup(pid) {
    this.temporaryGroups.delete(pid)
    delete this.recordedGroups[`temporary:${pid}`]
    this.writePidFile()
  }

  /**
   * Records a process group in `pidFile` with its leader's start time, which
   * `reapOrphans` compares to tell it from a later process that reused the ID.
   * @param {string} key The service name, or `temporary:<pid>`.
   * @param {number} pid The group's leader.
   */
  recordGroup(key, pid) {
    if (!this.pidFile) return
    this.recordedGroups[key] = { pid, startedAt: processStartTime(pid) }
    this.writePidFile()
  }

  /** Returns each service's current status for diagnostics and the preload bridge. */
  snapshot() {
    return Object.fromEntries(
      [...this.status].map(([name, value]) => [name, { ...value }])
    )
  }

  /**
   * Stops every service without ending the supervisor, for `relocate`. The
   * stopped children are retired so their exits do not schedule restarts.
   */
  async pause() {
    clearInterval(this.livenessTimer)
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()
    const running = [...this.children.entries()]
    for (const [, child] of running) this.retired.add(child)
    await Promise.all(running.map(([, child]) => this.stopChild(child)))
    for (const [name] of running) this.setStatus(name, { state: "stopped" })
    this.children.clear()
  }

  /** Stops every managed process group, cancels pending restarts, and waits for exits. */
  async stop() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.livenessTimer)
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()
    const running = [...this.children.entries()]
    await Promise.all(running.map(([, child]) => this.stopChild(child)))
    for (const [name] of running) this.setStatus(name, { state: "stopped" })
    for (const [name, status] of this.status)
      if (status.state === "restarting")
        this.setStatus(name, { state: "stopped", nextRestartAt: undefined })
    this.children.clear()
  }

  /**
   * Synchronously kills every running process group. Used from a launcher's
   * `exit` hook, where asynchronous shutdown cannot run, so detached children
   * never outlive a crashed launcher.
   */
  killNow() {
    for (const child of this.children.values()) {
      if (!child.pid) continue
      try {
        if (process.platform !== "win32") this.killProcess(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }
    if (process.platform === "win32") return
    for (const pid of this.temporaryGroups)
      try {
        this.killProcess(-pid, "SIGKILL")
      } catch {}
  }

  /**
   * Stops process groups recorded in `pidFile` by an earlier launcher that was
   * killed before it could clean up (`SIGKILL` skips every exit hook),
   * including builds and trial servers it had started.
   *
   * A group is ours when its leader is gone, since an ID cannot be reused
   * while its group still has members, or when the leader has the start time
   * recorded with it. A process that reused the ID has a different start time
   * and is left alone. Entries without a start time, written before it was
   * recorded, fall back to matching a word in the group's command lines.
   */
  async reapOrphans() {
    if (!this.pidFile || process.platform === "win32") return
    let recorded
    try {
      recorded = JSON.parse(await readFile(this.pidFile, "utf8"))
    } catch {
      return
    }
    let groups
    /** Reports whether a recorded group is still the one this supervisor started. */
    const isOurs = (entry) => {
      if (!Number.isInteger(entry?.pid) || !processGroupExists(entry.pid, this.killProcess))
        return false
      if (typeof entry.startedAt === "string") {
        const leaderStartedAt = processStartTime(entry.pid)
        return !leaderStartedAt || leaderStartedAt === entry.startedAt
      }
      if (typeof entry.match !== "string") return false
      groups ??= listProcessGroups()
      return (groups.get(entry.pid) ?? []).some((command) => command.includes(entry.match))
    }
    const orphans = Object.values(recorded ?? {}).filter(isOurs)
    if (orphans.length > 0)
      await terminateProcessGroups(
        orphans.map((entry) => entry.pid),
        { graceMs: this.shutdownGraceMs, killProcess: this.killProcess }
      )
    this.recordedGroups = {}
    this.writePidFile()
  }

  /** Mirrors the running process groups to `pidFile`, when one is configured. */
  writePidFile() {
    if (!this.pidFile) return
    try {
      mkdirSync(dirname(this.pidFile), { recursive: true })
      writeFileSync(this.pidFile, JSON.stringify(this.recordedGroups))
    } catch {
      // Only orphan cleanup after a crash depends on this file.
    }
  }

  /** Records how to launch one named service so restarts reuse the same command. */
  define(name, command, args) {
    this.definitions.set(name, { command, args })
  }

  /** Spawns one defined service and schedules a backoff restart if it exits unexpectedly. */
  startService(name) {
    if (this.stopping) return
    const definition = this.definitions.get(name)
    if (!definition) return
    const child = this.spawnProcess(definition.command, definition.args, {
      cwd: this.cwd,
      env: this.environment,
      stdio: this.stdio,
      detached: process.platform !== "win32",
    })
    const startedAt = Date.now()
    this.startedAt.set(name, startedAt)
    this.livenessFailures.set(name, 0)
    this.restartTimers.delete(name)
    this.children.set(name, child)
    if (child.pid) this.recordGroup(name, child.pid)
    let handled = false
    /** Handles the first of `error` or `exit`; Node may emit both for one failure. */
    const onEnded = (reason) => {
      if (handled) return
      handled = true
      if (this.children.get(name) === child) {
        this.children.delete(name)
        delete this.recordedGroups[name]
        this.writePidFile()
      }
      if (this.stopping || this.retired.has(child)) {
        this.setStatus(name, { state: "stopped", lastExit: reason })
        return
      }
      const killReason = this.killReasons.get(name)
      this.killReasons.delete(name)
      this.scheduleRestart(name, startedAt, killReason ?? reason)
    }
    child.once("error", (error) => onEnded(`error: ${error.message}`))
    child.once("exit", (code, signal) =>
      onEnded(String(signal || code || "unknown"))
    )
    this.setStatus(name, { state: "running", nextRestartAt: undefined })
  }

  /** Restarts a service after a delay that grows with consecutive quick failures. */
  scheduleRestart(name, startedAt, reason) {
    const uptime = Date.now() - startedAt
    const attempt =
      uptime >= this.stableUptimeMs ? 0 : this.attempts.get(name) || 0
    const delay = Math.min(
      this.restartBaseDelayMs * 2 ** attempt,
      this.restartMaxDelayMs
    )
    this.attempts.set(name, attempt + 1)
    const previous = this.status.get(name)
    this.setStatus(name, {
      state: "restarting",
      restarts: (previous?.restarts || 0) + 1,
      lastExit: reason,
      nextRestartAt: Date.now() + delay,
    })
    this.restartTimers.set(
      name,
      setTimeout(() => this.startService(name), delay)
    )
  }

  /** Returns the URL that proves each probed service is answering. */
  livenessTargets() {
    const targets = [["next", `http://127.0.0.1:${this.port}/api/health`]]
    if (this.definitions.has("convex"))
      targets.push(["convex", this.environment.BLITZ_CONVEX_URL])
    return targets
  }

  /**
   * Probes Next and Convex once. A service that misses `livenessFailureLimit`
   * probes in a row after its startup grace period is killed, and its exit
   * handler schedules the restart.
   */
  async checkLiveness() {
    if (this.checkingLiveness || this.stopping) return
    this.checkingLiveness = true
    try {
      for (const [name, url] of this.livenessTargets()) {
        const child = this.children.get(name)
        if (
          !child ||
          Date.now() - (this.startedAt.get(name) || 0) < this.livenessGraceMs
        )
          continue
        let healthy = false
        try {
          const response = await this.fetchImpl(url, {
            signal: AbortSignal.timeout(5_000),
          })
          healthy = response.status < 500
        } catch {}
        const failures = healthy ? 0 : (this.livenessFailures.get(name) || 0) + 1
        this.livenessFailures.set(name, failures)
        if (failures >= this.livenessFailureLimit && !this.stopping) {
          this.livenessFailures.set(name, 0)
          this.killReasons.set(name, "unresponsive")
          void this.stopChild(child)
        }
      }
    } finally {
      this.checkingLiveness = false
    }
  }

  /** Merges a status change and notifies the launcher. */
  setStatus(name, change) {
    const previous = this.status.get(name) || {
      state: "stopped",
      restarts: 0,
      since: Date.now(),
    }
    const next = {
      ...previous,
      ...change,
      since: change.state && change.state !== previous.state
        ? Date.now()
        : previous.since,
    }
    this.status.set(name, next)
    if (change.state && change.state !== previous.state) this.onStatus(name, next)
  }

  /**
   * Waits for Next and Convex to accept requests. Restarts while waiting are
   * allowed; only the overall timeout fails startup.
   * @param {{stopOnFailure?: boolean}} [options] Whether a timeout stops the whole stack first.
   */
  async waitForHealth({ stopOnFailure = true } = {}) {
    const deadline = Date.now() + this.healthTimeoutMs
    const checkConvex = this.definitions.has("convex")
    let lastError
    let nextReady = false
    let convexReady = !checkConvex
    while (Date.now() < deadline) {
      try {
        if (!nextReady) {
          const response = await this.fetchImpl(
            `http://127.0.0.1:${this.port}/api/health`,
            { signal: AbortSignal.timeout(1_500) }
          )
          if (response.status < 500) {
            nextReady = true
            this.setStatus("next", { state: "ready" })
          } else lastError = new Error(`Next HTTP ${response.status}`)
        }
        if (!convexReady) {
          const response = await this.fetchImpl(
            this.environment.BLITZ_CONVEX_URL,
            { signal: AbortSignal.timeout(1_500) }
          )
          if (response.status < 500) {
            convexReady = true
            this.setStatus("convex", { state: "ready" })
          } else lastError = new Error(`Convex HTTP ${response.status}`)
        }
        if (nextReady && convexReady) return
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, this.healthIntervalMs))
    }
    if (stopOnFailure) await this.stop()
    throw new Error(
      `Blitz did not become healthy: ${lastError?.message || "timeout"}`
    )
  }

  /**
   * Terminates one process group and waits until every member is gone, killing
   * survivors after `shutdownGraceMs`. The leader exiting is not enough: a
   * descendant that ignores `SIGTERM` could keep a port or the database open
   * into the next start. Then waits briefly for the leader's `exit` event, so
   * its handler runs before a replacement starts under the same name.
   * @param {ManagedChild} child The group's leader, started with `detached: true`.
   */
  async stopChild(child) {
    if (!child.pid) return
    const alreadyExited = child.exitCode != null || child.signalCode != null
    const exited = alreadyExited
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve))
    if (process.platform === "win32") {
      try {
        child.kill("SIGTERM")
      } catch {
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
      }, this.shutdownGraceMs)
      await exited
      clearTimeout(timer)
      return
    }
    try {
      await terminateProcessGroups([child.pid], {
        graceMs: this.shutdownGraceMs,
        killProcess: this.killProcess,
      })
    } catch {
      // Not permitted to signal the group; nothing more can be done from here.
      return
    }
    // A killed process disappears a moment after `SIGKILL` is sent.
    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
      let gone
      try {
        gone = !processGroupExists(child.pid, this.killProcess)
      } catch {
        gone = true
      }
      if (gone) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.()),
    ])
  }
}
