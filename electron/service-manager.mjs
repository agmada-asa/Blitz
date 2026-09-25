/** Supervises Blitz's local Next, Convex, and worker processes for the desktop host. */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

/** @typedef {import("node:events").EventEmitter & {pid?: number, kill?: (signal?: string) => void}} ManagedChild */
/** @typedef {(command: string, args: string[], options: object) => ManagedChild} SpawnProcess */
/** @typedef {(url: string, options?: object) => Promise<{ok: boolean, status: number}>} HealthFetch */
/** @typedef {(pid: number, signal?: string) => unknown} ProcessKiller */

const workerDefinitions = [
  ["ingestion", "worker:ingestion"],
  ["preparation", "worker"],
  ["content", "worker:content"],
  ["chat", "worker:chat"],
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

/** Manages process groups, health checks, and one bounded worker restart. */
export class ServiceManager {
  /** Creates a stopped supervisor with the supplied repository and port settings. */
  /**
   * @param {{cwd: string, port?: number, host?: string, spawnProcess?: SpawnProcess, fetchImpl?: HealthFetch, killProcess?: ProcessKiller, workerRestartDelayMs?: number, healthIntervalMs?: number, shutdownGraceMs?: number}} options
   */
  constructor({
    cwd,
    port = Number(process.env.BLITZ_PORT || 3001),
    host = process.env.BLITZ_DESKTOP_HOST || "127.0.0.1",
    spawnProcess = spawn,
    fetchImpl = globalThis.fetch,
    killProcess = process.kill,
    workerRestartDelayMs = 500,
    healthIntervalMs = 250,
    shutdownGraceMs = 3_000,
  }) {
    this.cwd = cwd
    this.port = port
    this.host = host
    this.children = new Map()
    this.restartCounts = new Map()
    this.stopping = false
    this.status = new Map()
    this.spawnProcess = spawnProcess
    this.fetchImpl = fetchImpl
    this.killProcess = killProcess
    this.workerRestartDelayMs = workerRestartDelayMs
    this.healthIntervalMs = healthIntervalMs
    this.shutdownGraceMs = shutdownGraceMs
  }

  /** Resolves Blitz's local Convex ports, starts services, and waits for Next. */
  async start() {
    const convexPorts = await resolveLocalConvexPorts(this.cwd)
    const convexHost = process.env.BLITZ_LAN_ADDRESS || "127.0.0.1"
    const environment = {
      ...process.env,
      BLITZ_PORT: String(this.port),
      BLITZ_SERVER_URL: `http://127.0.0.1:${this.port}`,
      BLITZ_CONVEX_URL: `http://127.0.0.1:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_URL: `http://${convexHost}:${convexPorts.cloud}`,
      NEXT_PUBLIC_CONVEX_SITE_URL: `http://${convexHost}:${convexPorts.site}`,
      BLITZ_DESKTOP: "1",
      BLITZ_NEXT_DIST_DIR: process.env.BLITZ_NEXT_DIST_DIR || ".next-desktop",
    }
    this.environment = environment
    if (process.env.BLITZ_DESKTOP_SKIP_CONVEX !== "1")
      this.startService(
        "convex",
        "npx",
        [
          "convex",
          "dev",
          "--tail-logs",
          "disable",
          "--local-cloud-port",
          String(convexPorts.cloud),
          "--local-site-port",
          String(convexPorts.site),
        ],
        environment
      )
    this.startService(
      "next",
      "npm",
      [
        "run",
        "dev",
        "--",
        "--hostname",
        this.host,
        "--port",
        String(this.port),
      ],
      environment
    )
    await this.waitForHealth()
    if (process.env.BLITZ_DESKTOP_SKIP_WORKERS !== "1")
      for (const [name, script] of workerDefinitions)
        this.startService(name, "npm", ["run", script], environment)
  }

  /** Returns a stable snapshot for diagnostics and the preload status method. */
  snapshot() {
    return Object.fromEntries(
      [...this.status].map(([name, value]) => [name, value])
    )
  }

  /** Stops every managed process group and waits for exits where possible. */
  async stop() {
    if (this.stopping) return
    this.stopping = true
    const children = [...this.children.values()]
    await Promise.all(children.map((child) => this.stopChild(child)))
    this.children.clear()
  }

  /** Starts one process and restarts a worker once after an unexpected exit. */
  startService(name, command, args, environment) {
    if (this.stopping) return
    const executable =
      process.platform === "win32" && command === "npm" ? "npm.cmd" : command
    const child = this.spawnProcess(executable, args, {
      cwd: this.cwd,
      env: environment,
      stdio: "inherit",
      detached: process.platform !== "win32",
    })
    this.children.set(name, child)
    this.status.set(name, "starting")
    child.once("error", (error) => {
      this.status.set(name, `error: ${error.message}`)
    })
    child.once("exit", (code, signal) => {
      this.children.delete(name)
      if (this.stopping) {
        this.status.set(name, "stopped")
        return
      }
      const restartCount = this.restartCounts.get(name) || 0
      if (
        workerDefinitions.some(([worker]) => worker === name) &&
        restartCount < 1
      ) {
        this.restartCounts.set(name, restartCount + 1)
        this.status.set(name, "restarting")
        setTimeout(
          () => this.startService(name, command, args, environment),
          this.workerRestartDelayMs
        )
        return
      }
      this.status.set(name, `stopped (${signal || code || "unknown"})`)
      if (name === "next" || name === "convex") this.stop()
    })
  }

  /** Waits for the web process to accept requests before opening the BrowserWindow. */
  async waitForHealth() {
    const deadline =
      Date.now() + Number(process.env.BLITZ_DESKTOP_HEALTH_TIMEOUT_MS || 30_000)
    let lastError
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(
          `http://127.0.0.1:${this.port}/`,
          {
            signal: AbortSignal.timeout(1_500),
          }
        )
        if (response.ok || response.status < 500) {
          if (process.env.BLITZ_DESKTOP_SKIP_CONVEX !== "1") {
            const convexResponse = await this.fetchImpl(
              this.environment?.BLITZ_CONVEX_URL || "http://127.0.0.1:3220",
              { signal: AbortSignal.timeout(1_500) }
            )
            if (convexResponse.status >= 500) {
              lastError = new Error(`Convex HTTP ${convexResponse.status}`)
              continue
            }
            this.status.set("convex", "ready")
          }
          this.status.set("next", "ready")
          return
        }
        lastError = new Error(`HTTP ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, this.healthIntervalMs))
    }
    await this.stop()
    throw new Error(
      `Blitz web host did not become healthy: ${lastError?.message || "timeout"}`
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
