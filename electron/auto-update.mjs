/**
 * Keeps a production Blitz stack on the newest commit of the tracked branch.
 *
 * On launch and every 15 minutes the updater fetches the branch. When it has
 * moved, the new commit is built into a fresh release beside the running one
 * (`release-manager.mjs`), then switched to in this order, so a broken commit
 * never replaces a working server:
 *
 * 1. Build. A failed install or `next build` leaves everything running.
 * 2. Try the new Next server on a spare port; it must serve `/`.
 * 3. Wait (up to ten minutes) until no chat reply is streaming.
 * 4. Push the new Convex functions to the running backend. The push is
 *    atomic, so a schema the stored data does not match changes nothing.
 * 5. Restart every service from the new release (a few seconds offline).
 *    If it does not become healthy, the previous release starts again.
 *
 * A failed commit is not retried every 15 minutes; a newer commit or
 * "Rebuild now" tries again. The outcome is written to `run/state.json`, which
 * the desktop app and `npm run server` read, and a `SIGUSR2` asks the process
 * hosting the updater to check now (see `requestUpdate`).
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { currentRelease, homePaths, readServerConfig } from "./release-manager.mjs"

/** How often the tracked branch is fetched. */
export const CHECK_INTERVAL_MS = 15 * 60_000

/**
 * The files that make up the updater and supervisor. When an update changes
 * them, the background server restarts itself so the new code takes over.
 */
export const RUNNER_FILES = [
  "electron/auto-update.mjs",
  "electron/background-server.mjs",
  "electron/login-environment.mjs",
  "electron/release-manager.mjs",
  "electron/service-manager.mjs",
  "scripts/dev-lan.mjs",
  "scripts/process-groups.mjs",
]

/**
 * @typedef {"up-to-date" | "updated" | "failed" | "skipped" | "offline"} CheckStatus
 * @typedef {{status: CheckStatus, message: string, commit?: string, target?: string, logPath?: string, at: string, reason: string}} CheckResult
 * @typedef {{pid: number, host: string, port: number, branch: string, startedAt: string, release?: {commit: string, id: string, builtAt: string, directory: string}, phase?: {name: string, target?: string, since: string}, lastCheck?: CheckResult, failure?: {commit?: string, message: string, logPath?: string, at: string} | null}} ServerState
 */

/**
 * Returns the short form of a commit for messages.
 * @param {string | undefined} commit A full commit hash.
 */
export function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : "unknown"
}

/**
 * Reads the state the running updater last wrote.
 * @param {string} home The Blitz home directory.
 * @returns {Promise<ServerState | undefined>} Nothing when no updater has run.
 */
export async function readServerState(home) {
  try {
    return JSON.parse(await readFile(join(homePaths(home).run, "state.json"), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Asks the process hosting the updater to check for updates now, or to
 * rebuild the newest commit even when it is already running or failed before.
 * @param {string} home The Blitz home directory.
 * @param {"check" | "rebuild"} action What to do.
 * @returns {Promise<string>} The request time, to pass to `waitForCheck`.
 * @throws When no updater is running.
 */
export async function requestUpdate(home, action) {
  const state = await readServerState(home)
  if (!state?.pid || !isAlive(state.pid))
    throw new Error("The Blitz server is not running, so there is nothing to update.")
  const requestedAt = new Date().toISOString()
  const run = homePaths(home).run
  await mkdir(run, { recursive: true })
  await writeAtomically(join(run, "request.json"), { action, requestedAt })
  process.kill(state.pid, "SIGUSR2")
  return requestedAt
}

/**
 * Waits until the updater records a check that finished after `since`.
 * @param {string} home The Blitz home directory.
 * @param {string} since An ISO time from `requestUpdate`.
 * @param {{timeoutMs?: number, pollMs?: number}} [options] A build can take a few minutes.
 * @returns {Promise<CheckResult>} The finished check.
 * @throws When the updater stops or does not finish in time.
 */
export async function waitForCheck(home, since, { timeoutMs = 20 * 60_000, pollMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readServerState(home)
    if (state?.lastCheck && state.lastCheck.at >= since) return state.lastCheck
    if (state?.pid && !isAlive(state.pid))
      throw new Error("The Blitz server stopped before it finished.")
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error("Blitz is still updating. Check again in a few minutes.")
}

/**
 * Reports whether a process exists.
 * @param {number} pid The process ID.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

/**
 * Writes JSON through a temporary file and rename, so readers never see half a file.
 * @param {string} path The destination.
 * @param {unknown} value The JSON value.
 */
async function writeAtomically(path, value) {
  const pending = `${path}.${process.pid}.tmp`
  await writeFile(pending, JSON.stringify(value, null, 2))
  await rename(pending, path)
}

/**
 * Hashes the runner files in a release, to tell whether an update changed them.
 * @param {string} directory A release directory.
 */
async function hashRunner(directory) {
  const hash = createHash("sha256")
  for (const file of RUNNER_FILES) {
    hash.update(file)
    try {
      hash.update(await readFile(join(directory, file)))
    } catch {
      hash.update("missing")
    }
  }
  return hash.digest("hex")
}

/** Checks the tracked branch and moves the supervised stack to new releases. */
export class AutoUpdater {
  /**
   * @param {{
   *   releases: import("./release-manager.mjs").ReleaseManager,
   *   services: import("./service-manager.mjs").ServiceManager,
   *   home: string,
   *   host: "server" | "desktop",
   *   intervalMs?: number,
   *   idleTimeoutMs?: number,
   *   idlePollMs?: number,
   *   fetchImpl?: typeof fetch,
   *   log?: (message: string) => void,
   *   onRunnerChanged?: () => void,
   * }} options `onRunnerChanged` runs after an update that changed `RUNNER_FILES`.
   */
  constructor({
    releases,
    services,
    home,
    host,
    intervalMs = CHECK_INTERVAL_MS,
    idleTimeoutMs = 10 * 60_000,
    idlePollMs = 5_000,
    fetchImpl = globalThis.fetch,
    log = (message) => console.log(`[blitz] ${message}`),
    onRunnerChanged,
  }) {
    this.releases = releases
    this.services = services
    this.home = home
    this.intervalMs = intervalMs
    this.idleTimeoutMs = idleTimeoutMs
    this.idlePollMs = idlePollMs
    this.fetchImpl = fetchImpl
    this.log = log
    this.onRunnerChanged = onRunnerChanged
    /** @type {ServerState} */
    this.state = {
      pid: process.pid,
      host,
      port: services.port,
      branch: releases.config.branch,
      startedAt: new Date().toISOString(),
      failure: null,
    }
  }

  /**
   * Makes sure the current release was built for this launch's Convex URL,
   * building one first when there is none or the database moved to another
   * port (the URL is inlined into the browser bundle). Call before `services.start()`.
   * @returns {Promise<import("./release-manager.mjs").ReleaseMetadata & {directory: string}>} The release to serve.
   * @throws When nothing can be built, such as on a first launch without network.
   */
  async prepare() {
    const previous = await readServerState(this.home)
    // Keep the last failure, so a restart does not retry a commit that is known to fail.
    if (previous?.failure) this.state.failure = previous.failure
    const buildEnvironment = await this.buildEnvironment()
    let release = await currentRelease(this.home)
    if (!release || release.convexUrl !== buildEnvironment.NEXT_PUBLIC_CONVEX_URL) {
      const commit = release?.commit ?? (await this.releases.fetchTarget())
      if (!release && !(await this.releases.canServe(commit)))
        throw new Error(
          `${this.releases.config.branch} (${shortCommit(commit)}) does not include the Blitz server yet. Install from a branch that does with npm run server -- install --ref <branch>.`
        )
      this.log(
        release
          ? "The database moved to another port, so Blitz is rebuilding for it."
          : `Building Blitz ${shortCommit(commit)}. This takes about a minute.`
      )
      this.setPhase("building", commit)
      await this.writeState()
      const built = await this.releases.build(commit, buildEnvironment)
      await this.releases.activate(built.directory)
      release = built
      this.setPhase(undefined)
    }
    this.services.cwd = release.directory
    this.recordRelease(release)
    await this.writeState()
    return release
  }

  /** Starts the launch check and the 15-minute schedule. */
  start() {
    clearInterval(this.timer)
    this.timer = setInterval(
      () => void this.check({ reason: "scheduled" }),
      this.intervalMs
    )
    void this.check({ reason: "launch" })
  }

  /** Stops the schedule. A check in progress finishes on its own. */
  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Answers `SIGUSR2` from `requestUpdate` by reading `run/request.json`.
   * Without a request file it checks for updates.
   */
  listenForRequests() {
    process.on("SIGUSR2", () => {
      void (async () => {
        const path = join(homePaths(this.home).run, "request.json")
        let action = "check"
        try {
          action = JSON.parse(await readFile(path, "utf8")).action
          await rm(path, { force: true })
        } catch {}
        await this.check({ rebuild: action === "rebuild", reason: "manual" })
      })()
    })
  }

  /**
   * Fetches the branch and updates when it moved. Concurrent calls share the
   * check already running.
   * @param {{rebuild?: boolean, reason?: string}} [options] `rebuild` builds the newest commit even when it is running or failed before.
   * @returns {Promise<CheckResult>}
   */
  check({ rebuild = false, reason = "manual" } = {}) {
    this.inFlight ??= this.runCheck({ rebuild, reason }).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /**
   * Runs one check and records its outcome.
   * @param {{rebuild: boolean, reason: string}} options
   * @returns {Promise<CheckResult>}
   */
  async runCheck({ rebuild, reason }) {
    this.setPhase("checking")
    await this.writeState()
    // Pick up edits to config.json, such as another branch, without a restart.
    const config = await readServerConfig(this.home)
    if (config) {
      this.releases.config = config
      this.state.branch = config.branch
    }
    /** @type {Omit<CheckResult, "at" | "reason">} */
    let outcome
    try {
      outcome = await this.update({ rebuild })
    } catch (error) {
      outcome = {
        status: "failed",
        target: error?.target,
        message: error instanceof Error ? error.message : String(error),
        logPath: error?.logPath,
      }
    }
    const result = { ...outcome, at: new Date().toISOString(), reason }
    this.state.lastCheck = result
    if (result.status === "updated") this.state.failure = null
    if (result.status === "failed" && !outcome.repeated)
      this.state.failure = {
        commit: result.target,
        message: result.message,
        logPath: result.logPath,
        at: result.at,
      }
    this.setPhase(undefined)
    await this.writeState()
    if (result.status !== "up-to-date") this.log(result.message)
    if (outcome.runnerChanged) this.onRunnerChanged?.()
    return result
  }

  /**
   * Fetches, builds, and switches to the newest commit. See the file comment
   * for the order of steps.
   * @param {{rebuild: boolean}} options
   * @throws With `target` and `logPath` when the update failed; the running release is unchanged.
   */
  async update({ rebuild }) {
    const current = this.state.release
    const branch = this.releases.config.branch
    let target
    try {
      target = await this.releases.fetchTarget()
    } catch (error) {
      return {
        status: "offline",
        message: `Could not check for updates: ${firstLine(error)}`,
      }
    }
    if (!rebuild && target === current?.commit)
      return {
        status: "up-to-date",
        commit: target,
        message: `Blitz is up to date (${shortCommit(target)}).`,
      }
    const failure = this.state.failure
    if (!rebuild && failure?.commit === target)
      return {
        status: "failed",
        target,
        repeated: true,
        message: failure.message,
        logPath: failure.logPath,
      }
    if (!(await this.releases.canServe(target)))
      return {
        status: "skipped",
        target,
        message: `The newest ${branch} commit (${shortCommit(target)}) does not include the Blitz server, so Blitz is staying on ${shortCommit(current?.commit)}.`,
      }

    this.setPhase("building", target)
    await this.writeState()
    let built
    try {
      built = await this.releases.build(target, await this.buildEnvironment())
    } catch (error) {
      throw Object.assign(new Error(`Blitz could not build ${shortCommit(target)}. ${firstLine(error)}`), {
        target,
        logPath: error?.logPath,
      })
    }

    const convexUrl = this.services.environment.BLITZ_CONVEX_URL
    let pushed = false
    try {
      this.setPhase("trying the new version", target)
      await this.writeState()
      await this.services.probe(built.directory)
      this.setPhase("waiting for replies to finish", target)
      await this.writeState()
      await this.waitForIdle()
      this.setPhase("switching", target)
      await this.writeState()
      await this.releases.pushConvexFunctions(built.directory, convexUrl, built.logPath)
      pushed = true
      await this.services.relocate(built.directory)
    } catch (error) {
      // `relocate` already restarted the old release, whose Convex start pushes
      // its functions; this covers a failure between the push and the restart.
      if (pushed && current)
        await this.releases
          .pushConvexFunctions(current.directory, convexUrl)
          .catch((pushError) => this.log(`Could not restore the previous functions: ${firstLine(pushError)}`))
      await this.releases.remove(built.directory)
      throw Object.assign(
        new Error(`Blitz built ${shortCommit(target)} but could not switch to it, so it is still running ${shortCommit(current?.commit)}. ${firstLine(error)}`),
        { target, logPath: built.logPath }
      )
    }

    await this.releases.activate(built.directory)
    this.recordRelease(built)
    const runnerChanged =
      Boolean(current) && (await hashRunner(current.directory)) !== (await hashRunner(built.directory))
    await this.releases.prune(current ? [current.directory] : [])
    return {
      status: "updated",
      commit: target,
      runnerChanged,
      message: `Blitz updated to ${shortCommit(target)}.`,
    }
  }

  /**
   * Waits until the running server reports no streaming chat reply, so a
   * restart does not cut one off. Gives up after `idleTimeoutMs`, and treats a
   * server that does not report the count as idle.
   */
  async waitForIdle() {
    const deadline = Date.now() + this.idleTimeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(
          `http://127.0.0.1:${this.services.port}/api/health`,
          { signal: AbortSignal.timeout(5_000) }
        )
        const body = await response.json()
        if (!(Number(body?.activeChatRuns) > 0)) return
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, this.idlePollMs))
    }
  }

  /** Returns the Convex URLs the browser bundle must be built with. */
  async buildEnvironment() {
    const environment = await this.services.prepareEnvironment()
    return {
      NEXT_PUBLIC_CONVEX_URL: environment.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_SITE_URL: environment.NEXT_PUBLIC_CONVEX_SITE_URL,
    }
  }

  /**
   * Records the release being served in the state.
   * @param {{commit: string, id: string, builtAt: string, directory: string}} release
   */
  recordRelease({ commit, id, builtAt, directory }) {
    this.state.release = { commit, id, builtAt, directory }
  }

  /**
   * Records what the updater is doing, or clears it.
   * @param {string | undefined} name The current step.
   * @param {string} [target] The commit being installed.
   */
  setPhase(name, target) {
    this.state.phase = name ? { name, target, since: new Date().toISOString() } : undefined
  }

  /** Writes `run/state.json`. A failed write only hides status from the desktop app. */
  async writeState() {
    try {
      const run = homePaths(this.home).run
      await mkdir(run, { recursive: true })
      await writeAtomically(join(run, "state.json"), this.state)
    } catch (error) {
      this.log(`Could not save the server state: ${firstLine(error)}`)
    }
  }
}

/**
 * Returns the first line of an error message.
 * @param {unknown} error Any thrown value.
 */
function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]
}
