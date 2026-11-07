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
 * 6. Point `current` at the new release.
 *
 * Steps 4 to 6 are one handover. If any of them fails, including a push that
 * times out after the backend may already have taken the new functions, the
 * services, the functions, and `current` are all returned to the previous
 * release (see `rollBack`). A crash during the handover needs no record of
 * it: the next launch serves `current`, still the previous release, and
 * starting its Convex service pushes that release's functions again.
 *
 * A failed commit is not retried every 15 minutes; a newer commit or
 * "Rebuild now" tries again. The outcome is written to `run/state.json`, which
 * the desktop app and `npm run server` read. `requestUpdate` asks the process
 * hosting the updater to check now: it writes a request file and sends `SIGUSR2`.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { processStartTime } from "../scripts/process-groups.mjs"
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

/** Answers to `requestUpdate` kept in the state, newest last, for `waitForCheck`. */
const KEPT_ANSWERS = 20

/**
 * @typedef {"up-to-date" | "updated" | "failed" | "skipped" | "offline"} CheckStatus
 * @typedef {{status: CheckStatus, message: string, commit?: string, target?: string, logPath?: string, at: string, reason: string}} CheckResult
 * @typedef {{pid: number, processStartedAt?: string, host: string, port: number, branch: string, startedAt: string, release?: {commit: string, id: string, builtAt: string, directory: string}, phase?: {name: string, target?: string, since: string}, lastCheck?: CheckResult, answers?: Record<string, CheckResult>, failure?: {commit?: string, message: string, logPath?: string, at: string} | null}} ServerState
 *   `processStartedAt` tells the updater's process from a later one that reused
 *   its ID. `answers` holds the results of recent requests by request ID.
 * @typedef {{id?: string, action: "check" | "rebuild"}} UpdateRequest
 * @typedef {"trial" | "push" | "relocate" | "activate"} HandoverStep
 *   The update step that was under way when the switch-over failed.
 * @typedef {{rebuild: boolean, reason: string, requestIds: string[], settled: boolean, promise: Promise<CheckResult>}} CheckRun
 *   One check, shared by every caller that joins it before it records its result.
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
 * Each request is its own file, so two requests in quick succession are both
 * answered, and one that arrives while the updater is starting waits for it.
 * @param {string} home The Blitz home directory.
 * @param {"check" | "rebuild"} action What to do.
 * @returns {Promise<string>} The request ID, to pass to `waitForCheck`.
 * @throws When no updater is running.
 */
export async function requestUpdate(home, action) {
  const state = await readServerState(home)
  if (!state || !isUpdaterProcess(state))
    throw new Error("The Blitz server is not running, so there is nothing to update.")
  const id = randomUUID()
  const requests = requestDirectory(home)
  await mkdir(requests, { recursive: true })
  await writeAtomically(join(requests, `${id}.json`), {
    id,
    action,
    requestedAt: new Date().toISOString(),
  })
  process.kill(state.pid, "SIGUSR2")
  return id
}

/**
 * Waits until the updater answers a request from `requestUpdate`.
 * @param {string} home The Blitz home directory.
 * @param {string} requestId The ID `requestUpdate` returned.
 * @param {{timeoutMs?: number, pollMs?: number}} [options] A build can take a few minutes.
 * @returns {Promise<CheckResult>} The check that answered the request.
 * @throws When the updater stops or does not finish in time.
 */
export async function waitForCheck(home, requestId, { timeoutMs = 20 * 60_000, pollMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readServerState(home)
    const answer = state?.answers?.[requestId]
    if (answer) return answer
    if (state && !isUpdaterProcess(state))
      throw new Error("The Blitz server stopped before it finished.")
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error("Blitz is still updating. Check again in a few minutes.")
}

/**
 * Returns the folder `requestUpdate` writes requests to.
 * @param {string} home The Blitz home directory.
 */
function requestDirectory(home) {
  return join(homePaths(home).run, "requests")
}

/**
 * Reports whether the process that wrote a state is still running. The start
 * time recorded with it rules out an unrelated process that reused the ID,
 * which a `SIGUSR2` would terminate.
 * @param {ServerState} state A state from `readServerState`.
 */
function isUpdaterProcess(state) {
  if (!Number.isInteger(state.pid) || !isAlive(state.pid)) return false
  // States written before the start time was recorded are trusted on the ID alone.
  return !state.processStartedAt || processStartTime(state.pid) === state.processStartedAt
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
 * Writes JSON through a temporary file and rename, so readers never see half
 * a file. The temporary name is unique, so concurrent writes cannot mix.
 * @param {string} path The destination.
 * @param {unknown} value The JSON value.
 */
async function writeAtomically(path, value) {
  const pending = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(pending, JSON.stringify(value, null, 2))
    await rename(pending, path)
  } catch (error) {
    await rm(pending, { force: true })
    throw error
  }
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
    /** @type {CheckRun | undefined} The check under way. */
    this.running = undefined
    /** @type {CheckRun | undefined} A check waiting for `running` to finish. */
    this.next = undefined
    /** Whether `start` ran; requests before then wait in `waitingRequests`. */
    this.started = false
    /** @type {UpdateRequest[]} */
    this.waitingRequests = []
    /** @type {(() => void) | undefined} Ends a `waitForRequest` early. */
    this.wake = undefined
    /** @type {ServerState} */
    this.state = {
      pid: process.pid,
      processStartedAt: processStartTime(process.pid),
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
    // Keep the last failure, so a restart does not retry a commit that is known
    // to fail, and recent answers, so a request answered just before a restart
    // for new runner code still finds its result.
    if (previous?.failure) this.state.failure = previous.failure
    if (previous?.answers) this.state.answers = previous.answers
    if (previous?.lastCheck) this.state.lastCheck = previous.lastCheck
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

  /**
   * Starts the launch check and the 15-minute schedule, then answers the
   * requests that arrived while the services were starting.
   */
  start() {
    this.started = true
    clearInterval(this.timer)
    this.timer = setInterval(
      () => void this.check({ reason: "scheduled" }),
      this.intervalMs
    )
    void this.check({ reason: "launch" })
    for (const request of this.waitingRequests.splice(0)) this.answer(request)
  }

  /** Stops the schedule. A check in progress finishes on its own. */
  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Answers `SIGUSR2` from `requestUpdate`. Call it before `prepare`, which
   * publishes this process's ID: without a handler, `SIGUSR2` would end the
   * process. Requests that arrive before `start` wait for it, and also end a
   * `waitForRequest`, so a launch that is retrying tries again at once.
   */
  listenForRequests() {
    process.on("SIGUSR2", () => void this.takeRequests())
  }

  /**
   * Reads and removes every waiting request file, then answers each request
   * or holds it until `start`. A signal without a file is treated as a check.
   */
  async takeRequests() {
    const directory = requestDirectory(this.home)
    /** @type {UpdateRequest[]} */
    const requests = []
    let names = []
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json"))
    } catch {}
    for (const name of names) {
      const path = join(directory, name)
      try {
        const request = JSON.parse(await readFile(path, "utf8"))
        await rm(path, { force: true })
        requests.push({
          id: typeof request?.id === "string" ? request.id : undefined,
          action: request?.action === "rebuild" ? "rebuild" : "check",
        })
      } catch {
        // Taken by an earlier signal's handler, or unreadable.
      }
    }
    if (requests.length === 0) requests.push({ action: "check" })
    for (const request of requests) {
      if (this.started) this.answer(request)
      else this.waitingRequests.push(request)
    }
    if (!this.started) this.wake?.()
  }

  /**
   * Runs the check a request asked for, recording its result under the request's ID.
   * @param {UpdateRequest} request
   */
  answer(request) {
    void this.check({
      rebuild: request.action === "rebuild",
      reason: "manual",
      requestId: request.id,
    })
  }

  /**
   * Answers the requests held before `start` with a failure, when the launch
   * itself failed and will only be retried later.
   * @param {string} message Why Blitz could not start.
   */
  async failWaitingRequests(message) {
    const waiting = this.waitingRequests.splice(0)
    const at = new Date().toISOString()
    for (const request of waiting)
      if (request.id) this.recordAnswer(request.id, { status: "failed", message, at, reason: "manual" })
    if (waiting.length > 0) await this.writeState()
  }

  /**
   * Waits up to `ms`, ending early when a request arrives, for a launch that is
   * waiting to try again.
   * @param {number} ms The longest wait.
   */
  waitForRequest(ms) {
    return new Promise((resolve) => {
      /** Ends the wait, from the timer or a request. */
      const done = () => {
        clearTimeout(timer)
        if (this.wake === done) this.wake = undefined
        resolve(undefined)
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  /**
   * Fetches the branch and updates when it moved. A call joins the check
   * under way when that check does what it asks; a rebuild asked for during a
   * plain check runs after it instead, so it is never answered by a check that
   * did not rebuild. A call after a check has recorded its result starts a new
   * one, so its request ID is never missed.
   * @param {{rebuild?: boolean, reason?: string, requestId?: string}} [options]
   *   `rebuild` builds the newest commit even when it is running or failed
   *   before. `requestId` records the result for `waitForCheck`.
   * @returns {Promise<CheckResult>}
   */
  check({ rebuild = false, reason = "manual", requestId } = {}) {
    let run = this.next ?? (this.running && !this.running.settled ? this.running : undefined)
    if (run && rebuild && !run.rebuild) {
      if (run === this.next) {
        // It has not started, so it can still become a rebuild.
        run.rebuild = true
        run.reason = reason
      } else run = undefined
    }
    if (!run) {
      run = this.createRun({ rebuild, reason }, this.running?.promise)
      if (this.running) this.next = run
      else this.running = run
    }
    if (requestId) run.requestIds.push(requestId)
    return run.promise
  }

  /**
   * Creates a check that starts once `after` settles, so checks never overlap.
   * @param {{rebuild: boolean, reason: string}} options
   * @param {Promise<unknown>} [after] The check that must finish first.
   * @returns {CheckRun}
   */
  createRun({ rebuild, reason }, after) {
    /** @type {CheckRun} */
    const run = { rebuild, reason, requestIds: [], settled: false, promise: Promise.resolve(/** @type {never} */ (undefined)) }
    run.promise = (async () => {
      await after?.catch(() => undefined)
      this.running = run
      if (this.next === run) this.next = undefined
      try {
        return await this.runCheck(run)
      } finally {
        if (this.running === run) this.running = undefined
      }
    })()
    return run
  }

  /**
   * Records a request's result for `waitForCheck`, keeping the newest few.
   * @param {string} requestId The request's ID.
   * @param {CheckResult} result Its result.
   */
  recordAnswer(requestId, result) {
    const answers = { ...this.state.answers, [requestId]: result }
    this.state.answers = Object.fromEntries(Object.entries(answers).slice(-KEPT_ANSWERS))
  }

  /**
   * Runs one check and records its outcome, including for every request that joined it.
   * @param {CheckRun} run
   * @returns {Promise<CheckResult>}
   */
  async runCheck(run) {
    const { rebuild, reason } = run
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
    // From here a caller starts a new check instead of joining this one, so
    // every request that joined is in `requestIds` now.
    run.settled = true
    for (const requestId of run.requestIds) this.recordAnswer(requestId, result)
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
   * @throws With `target` and `logPath` when the update failed. The previous
   * release is serving again, unless it would not start, in which case the new
   * one stays and is recorded (see `rollBack`).
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

    /** @type {HandoverStep} How far the handover got, for `rollBack`. */
    let step = "trial"
    try {
      this.setPhase("trying the new version", target)
      await this.writeState()
      await this.services.probe(built.directory)
      this.setPhase("waiting for replies to finish", target)
      await this.writeState()
      await this.waitForIdle()
      this.setPhase("switching", target)
      await this.writeState()
      // From here the backend may hold the new functions, even when the push
      // reports a failure: it can time out after the backend took them.
      step = "push"
      await this.releases.pushConvexFunctions(
        built.directory,
        this.services.environment.BLITZ_CONVEX_URL,
        built.logPath
      )
      step = "relocate"
      await this.services.relocate(built.directory)
      step = "activate"
      await this.releases.activate(built.directory)
    } catch (error) {
      await this.rollBack(step, current)
      const reason = firstLine(error)
      if (this.services.cwd === built.directory) {
        // The previous release would not start again, so the new one stays.
        this.recordRelease(built)
        throw Object.assign(
          new Error(`Blitz switched to ${shortCommit(target)} but could not finish the update or go back to ${shortCommit(current?.commit)}. It restarts on ${shortCommit(current?.commit)} next time. ${reason}`),
          { target, logPath: built.logPath }
        )
      }
      await this.releases.remove(built.directory)
      throw Object.assign(
        new Error(`Blitz built ${shortCommit(target)} but could not switch to it, so it is still running ${shortCommit(current?.commit)}. ${reason}`),
        { target, logPath: built.logPath }
      )
    }

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
   * Returns the services and the Convex functions to the previous release
   * after a failed handover. `current` was never changed: `activate` is the
   * last step and replaces it atomically. Every step is best effort, and a
   * failure is logged; the caller reads `services.cwd` for what is served.
   * @param {HandoverStep} step The step that failed.
   * @param {ServerState["release"]} previous The release that was serving before.
   */
  async rollBack(step, previous) {
    if (step === "trial" || !previous) return
    const convexUrl = this.services.environment.BLITZ_CONVEX_URL
    if (step === "activate") {
      // Every service already runs the new release. Restarting them from the
      // previous one also pushes its functions, since Convex pushes on start.
      await this.services
        .relocate(previous.directory)
        .catch((error) => this.log(`Could not go back to the previous release: ${firstLine(error)}`))
      return
    }
    // "push" or "relocate": the services run the previous release (`relocate`
    // starts it again when the new one fails), but the backend may hold the
    // new functions. Pushing the previous ones is harmless if it does not.
    try {
      await this.releases.pushConvexFunctions(previous.directory, convexUrl)
    } catch (error) {
      this.log(`Could not restore the previous functions, so Blitz is restarting it: ${firstLine(error)}`)
      // Convex pushes the release's functions whenever it starts.
      await this.services
        .relocate(previous.directory)
        .catch((relocateError) => this.log(`Could not restart the previous release: ${firstLine(relocateError)}`))
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

  /**
   * Writes `run/state.json`. Writes run one at a time, each with the state as
   * it is then, so an older state never replaces a newer one. A failed write
   * only hides status from the desktop app and `npm run server`.
   */
  writeState() {
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      try {
        const run = homePaths(this.home).run
        await mkdir(run, { recursive: true })
        await writeAtomically(join(run, "state.json"), this.state)
      } catch (error) {
        this.log(`Could not save the server state: ${firstLine(error)}`)
      }
    })
    return this.writing
  }
}

/**
 * Returns the first line of an error message.
 * @param {unknown} error Any thrown value.
 */
function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]
}
