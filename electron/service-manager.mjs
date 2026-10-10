/** Supervises Blitz's local Next, Convex, and worker processes for the desktop app and `dev:lan`. */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

/** @typedef {import("node:events").EventEmitter & {pid?: number, kill?: (signal?: string) => void}} ManagedChild */
/** @typedef {(command: string, args: string[], options: object) => ManagedChild} SpawnProcess */
/** @typedef {(url: string, options?: object) => Promise<{ok: boolean, status: number}>} HealthFetch */
/** @typedef {(pid: number, signal?: string) => unknown} ProcessKiller */

/**
 * Background workers started after Next and Convex answer. Teach replaces the
 * old lesson, preparation, and card-chat workers, so only source recovery and
 * Deep Research run in the background.
 */
const workerDefinitions = [
  ["ingestion", "worker:ingestion"],
  ["research", "worker:research"],
]

/**
 * Reads the saved Blitz port pair, then checks upward by pairs when occupied.
 * @param {string} cwd Blitz's repository root containing the local Convex config.
 * @param {NodeJS.ProcessEnv} environment Optional port preferences for this launch.
 * @returns {Promise<{cloud: number, site: number}>} Ports reserved for Blitz startup.
 * @throws When no free pair is found before the bounded search ends.
 */
export async function resolveLocalConvexPorts(cwd, environment = process.env) {
  const savedConfigPath = join(
    cwd,
    ".convex",
    "local",
    "default",
    "config.json"
  )
  let savedCloudPort = 3220
  let savedSitePort = 3221
  try {
    const savedConfig = JSON.parse(await readFile(savedConfigPath, "utf8"))
    savedCloudPort = Number(savedConfig.ports?.cloud) || savedCloudPort
    savedSitePort = Number(savedConfig.ports?.site) || savedSitePort
  } catch {
    // A fresh local deployment uses Blitz's dedicated pair instead of 3210/3211.
  }

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
   * @param {{cwd: string, port?: number, host?: string, desktop?: boolean, environment?: NodeJS.ProcessEnv, spawnProcess?: SpawnProcess, fetchImpl?: HealthFetch, killProcess?: ProcessKiller, restartBaseDelayMs?: number, restartMaxDelayMs?: number, stableUptimeMs?: number, healthIntervalMs?: number, healthTimeoutMs?: number, livenessIntervalMs?: number, livenessGraceMs?: number, livenessFailureLimit?: number, shutdownGraceMs?: number, onStatus?: (name: string, status: ServiceStatus) => void}} options
   */
  constructor({
    cwd,
    port = Number(process.env.BLITZ_PORT || 3001),
    host = process.env.BLITZ_DESKTOP_HOST || "127.0.0.1",
    desktop = true,
    environment = process.env,
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
    // Longer than the launchers' own 3 s grace (scripts/process-groups.mjs), so
    // `npm run dev` can force-kill a hung Next group before it is killed itself.
    // Killing the launcher first would orphan Next with the port still bound.
    shutdownGraceMs = 5_000,
    onStatus = () => undefined,
  }) {
    this.cwd = cwd
    this.port = port
    this.host = host
    this.desktop = desktop
    this.baseEnvironment = environment
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
   * Resolves ports, starts Convex and Next, waits until both answer, then
   * starts the workers so their first requests do not fail.
   * @throws When Next or Convex does not become healthy before the timeout.
   */
  async start() {
    const base = this.baseEnvironment
    const convexPorts = await resolveLocalConvexPorts(this.cwd, base)
    // Browsers rewrite this loopback host to the page's own hostname, so the
    // same build works on this Mac, over LAN, and after a network change.
    const environment = {
      ...base,
      BLITZ_PORT: String(this.port),
      BLITZ_SERVER_URL: `http://127.0.0.1:${this.port}`,
      BLITZ_CONVEX_URL: `http://127.0.0.1:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${convexPorts.site}`,
      ...(this.desktop
        ? {
            BLITZ_DESKTOP: "1",
            BLITZ_NEXT_DIST_DIR: base.BLITZ_NEXT_DIST_DIR || ".next-desktop",
          }
        : {}),
    }
    this.environment = environment
    this.definitions = new Map()
    if (base.BLITZ_DESKTOP_SKIP_CONVEX !== "1")
      this.define("convex", "npx", [
        "convex",
        "dev",
        "--tail-logs",
        "disable",
        "--local-cloud-port",
        String(convexPorts.cloud),
        "--local-site-port",
        String(convexPorts.site),
      ])
    this.define("next", "npm", [
      "run",
      "dev",
      "--",
      "--hostname",
      this.host,
      "--port",
      String(this.port),
    ])
    for (const name of this.definitions.keys()) this.startService(name)
    await this.waitForHealth()
    this.livenessTimer = setInterval(
      () => void this.checkLiveness(),
      this.livenessIntervalMs
    )
    this.livenessTimer.unref?.()
    if (base.BLITZ_DESKTOP_SKIP_WORKERS !== "1")
      for (const [name, script] of workerDefinitions) {
        this.define(name, "npm", ["run", script])
        this.startService(name)
      }
  }

  /** Returns each service's current status for diagnostics and the preload bridge. */
  snapshot() {
    return Object.fromEntries(
      [...this.status].map(([name, value]) => [name, { ...value }])
    )
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
    const executable =
      process.platform === "win32" && definition.command === "npm"
        ? "npm.cmd"
        : definition.command
    const child = this.spawnProcess(executable, definition.args, {
      cwd: this.cwd,
      env: this.environment,
      stdio: "inherit",
      detached: process.platform !== "win32",
    })
    const startedAt = Date.now()
    this.startedAt.set(name, startedAt)
    this.livenessFailures.set(name, 0)
    this.restartTimers.delete(name)
    this.children.set(name, child)
    let handled = false
    /** Handles the first of `error` or `exit`; Node may emit both for one failure. */
    const onEnded = (reason) => {
      if (handled) return
      handled = true
      if (this.children.get(name) === child) this.children.delete(name)
      if (this.stopping) {
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
   */
  async waitForHealth() {
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
    await this.stop()
    throw new Error(
      `Blitz did not become healthy: ${lastError?.message || "timeout"}`
    )
  }

  /** Terminates one process group, escalating after a bounded grace period. */
  async stopChild(child) {
    if (!child.pid) return
    try {
      if (process.platform !== "win32") this.killProcess(-child.pid, "SIGTERM")
      else child.kill("SIGTERM")
    } catch {
      return
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform !== "win32")
            this.killProcess(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch {}
        resolve()
      }, this.shutdownGraceMs)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
