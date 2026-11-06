/**
 * Builds immutable Blitz releases from the tracked branch, outside the coding checkout.
 *
 * A long-lived `next dev` keeps every compiled route and hot-reload state in
 * memory and recompiles whenever an agent commits or switches branches in the
 * checkout, so the always-on server runs `next start` from a release instead: a
 * detached Git worktree of one commit with its own dependencies and production
 * build. A release is never edited after it is built. An update builds a new one
 * beside the running one, and `current` points at the release being served.
 *
 * Layout of the Blitz home (`BLITZ_HOME`, default `~/.blitz`):
 * - `config.json`: the repository URL, the tracked branch, and `sharedRoot`, the
 *   checkout whose `.env.local` and local Convex database every release uses.
 * - `repo.git`: a bare clone that releases are checked out from.
 * - `releases/<commit>-<time>`: one worktree per build attempt.
 * - `current`: a symlink to the release being served.
 * - `logs/`: build logs and service output. `run/`: state read by the desktop app.
 *
 * `buildCheckout` covers the other production case: serving a plain checkout
 * (a fresh clone without the background server), built into `.next-production`
 * so `npm run build` and `next dev` in the same checkout never replace the files
 * a running server is reading.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** A commit is served only if it contains this file, so a release can always update itself. */
export const RELEASE_MARKER = "electron/release-manager.mjs"

/** Written into each finished release; its absence marks an incomplete build. */
const RELEASE_METADATA = ".blitz-release.json"

/** Ignored files every release links from `sharedRoot`: settings and the local database. */
const SHARED_FILES = [".env.local", ".convex"]

/** Finished releases kept on disk, including the one being served, for rollback. */
const KEPT_RELEASES = 3

/** Build logs kept in `logs/`. */
const KEPT_BUILD_LOGS = 10

/** Distribution directory for production builds of a plain checkout. */
export const CHECKOUT_DIST_DIR = ".next-production"

/**
 * @typedef {{repository: string, branch: string, sharedRoot: string}} ServerConfig
 * @typedef {Record<string, string | undefined>} BuildEnvironment Variables inlined into the browser bundle, at least `NEXT_PUBLIC_CONVEX_URL`.
 * @typedef {{commit: string, id: string, builtAt: string, convexUrl: string, convexSiteUrl?: string, lockfileHash: string}} ReleaseMetadata
 * @typedef {{cwd?: string, env?: NodeJS.ProcessEnv, logPath?: string, timeoutMs?: number, label?: string}} RunOptions
 *   `label` names the command in errors, such as `next build` for a `nice` wrapper.
 * @typedef {(command: string, args: string[], options?: RunOptions) => Promise<string>} RunCommand
 */

/** A failed release build, carrying the log that explains it. */
export class ReleaseBuildError extends Error {
  /**
   * @param {string} message What failed, in one line.
   * @param {string | undefined} logPath The build log, when one was written.
   */
  constructor(message, logPath) {
    super(message)
    this.name = "ReleaseBuildError"
    this.logPath = logPath
  }
}

/**
 * Returns the Blitz home that holds releases and server state.
 * @param {NodeJS.ProcessEnv} [environment] Reads `BLITZ_HOME` when set.
 */
export function blitzHome(environment = process.env) {
  return resolve(environment.BLITZ_HOME?.trim() || join(homedir(), ".blitz"))
}

/**
 * Returns the fixed paths inside a Blitz home.
 * @param {string} home The Blitz home directory.
 */
export function homePaths(home) {
  return {
    config: join(home, "config.json"),
    repository: join(home, "repo.git"),
    releases: join(home, "releases"),
    current: join(home, "current"),
    logs: join(home, "logs"),
    run: join(home, "run"),
  }
}

/**
 * Reads the server configuration written by `npm run server -- install`.
 * @param {string} home The Blitz home directory.
 * @returns {Promise<ServerConfig | undefined>} Nothing when the server was never installed.
 */
export async function readServerConfig(home) {
  try {
    const config = JSON.parse(await readFile(homePaths(home).config, "utf8"))
    if (
      typeof config?.repository !== "string" ||
      typeof config?.branch !== "string" ||
      typeof config?.sharedRoot !== "string"
    )
      return undefined
    return config
  } catch {
    return undefined
  }
}

/**
 * Reads a finished release's metadata.
 * @param {string} directory A release directory.
 * @returns {Promise<(ReleaseMetadata & {directory: string}) | undefined>} Nothing for an unfinished or foreign directory.
 */
export async function readRelease(directory) {
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, RELEASE_METADATA), "utf8")
    )
    return typeof metadata?.commit === "string"
      ? { ...metadata, directory }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Returns the release `current` points at.
 * @param {string} home The Blitz home directory.
 */
export async function currentRelease(home) {
  try {
    const target = await readlink(homePaths(home).current)
    return await readRelease(resolve(home, target))
  } catch {
    return undefined
  }
}

/**
 * Runs a command in its own process group and resolves with its standard output.
 * Output is also appended to `logPath` when given. A timeout kills the whole
 * group, so a hung build cannot leave workers behind.
 * @type {RunCommand}
 * @throws When the command cannot start, exits non-zero, or times out. The
 * first line names the command and the first line of output that looks like
 * an error (a build prints many warnings after it); the last lines follow.
 */
export function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    logPath,
    timeoutMs = 10 * 60_000,
    label = `${command} ${args[0] ?? ""}`.trim(),
  } = options
  return new Promise((resolvePromise, reject) => {
    const log = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined
    log?.write(`\n$ ${command} ${args.join(" ")}\n`)
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let tail = ""
    let firstError
    /** Keeps the output for the caller and the error message, and copies it to the log. */
    const collect = (isStdout) => (chunk) => {
      const text = chunk.toString()
      if (isStdout && stdout.length < 1_000_000) stdout += text
      tail = (tail + text).slice(-2_000)
      firstError ??= text
        .split("\n")
        .find((line) => /\berror\b|ERR!|Failed to/i.test(line))
        ?.trim()
        .slice(0, 300)
      log?.write(chunk)
    }
    child.stdout.on("data", collect(true))
    child.stderr.on("data", collect(false))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }, timeoutMs)
    /** Settles once, after the log has flushed. */
    const finish = (error) => {
      clearTimeout(timer)
      const settle = () => (error ? reject(error) : resolvePromise(stdout))
      if (log) log.end(settle)
      else settle()
    }
    child.once("error", (error) =>
      finish(new Error(`Could not run ${command}: ${error.message}`))
    )
    child.once("close", (code, signal) => {
      if (code === 0) return finish()
      const reason = signal ? `was stopped (${signal})` : `exited with ${code}`
      const detail = tail.trim().split("\n").slice(-8).join("\n")
      const summary = firstError ? `: ${firstError}` : "."
      finish(new Error(`${label} ${reason}${summary}${detail ? `\n${detail}` : ""}`))
    })
  })
}

/**
 * Returns the environment for `next build`: the caller's environment plus the
 * Convex URLs inlined into the browser bundle. A custom `distDir` from an
 * earlier development launch must not leak into a production build.
 * @param {NodeJS.ProcessEnv} environment The base environment.
 * @param {BuildEnvironment} buildEnvironment The Convex URLs.
 * @param {string | undefined} distDir The distribution directory, or the default `.next`.
 */
function nextBuildEnvironment(environment, buildEnvironment, distDir) {
  const result = { ...environment, ...buildEnvironment, NODE_ENV: "production" }
  delete result.BLITZ_NEXT_DIST_DIR
  if (distDir) result.BLITZ_NEXT_DIST_DIR = distDir
  return result
}

/**
 * Runs `next build` at low CPU priority, so an update does not slow the Mac.
 * @param {RunCommand} run The command runner.
 * @param {string} directory The project directory to build.
 * @param {NodeJS.ProcessEnv} env The full build environment.
 * @param {string | undefined} logPath Where to append the build output.
 */
function runNextBuild(run, directory, env, logPath) {
  return run(
    "nice",
    ["-n", "10", "node", join("node_modules", "next", "dist", "bin", "next"), "build"],
    { cwd: directory, env, logPath, timeoutMs: 20 * 60_000, label: "next build" }
  )
}

/**
 * Hashes a file's contents, or returns undefined when it is missing.
 * @param {string} path The file to hash.
 */
async function hashFile(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch {
    return undefined
  }
}

/**
 * Builds a plain checkout for `next start` when its source or Convex URL changed
 * since the last build. The source fingerprint is the commit plus the hash of
 * uncommitted changes, so switching branches or editing files triggers a build.
 * @param {string} directory The checkout.
 * @param {BuildEnvironment} buildEnvironment The Convex URLs.
 * @param {{run?: RunCommand, environment?: NodeJS.ProcessEnv, force?: boolean, log?: (message: string) => void}} [options]
 * @returns {Promise<boolean>} Whether a build ran.
 * @throws When `next build` fails.
 */
export async function buildCheckout(directory, buildEnvironment, options = {}) {
  const {
    run = runCommand,
    environment = process.env,
    force = false,
    log = () => undefined,
  } = options
  const stampPath = join(directory, CHECKOUT_DIST_DIR, "blitz-build.json")
  let fingerprint = "unversioned"
  try {
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: directory })
    const changes = await run("git", ["status", "--porcelain=v1"], {
      cwd: directory,
    })
    const diff = await run("git", ["diff", "HEAD"], { cwd: directory })
    fingerprint = createHash("sha256")
      .update(`${head}\0${changes}\0${diff}`)
      .digest("hex")
  } catch {
    // Not a Git checkout: build every launch, since changes cannot be detected.
    log("This folder is not a Git checkout, so Blitz rebuilds it on every launch.")
  }
  const stamp = { fingerprint, convexUrl: buildEnvironment.NEXT_PUBLIC_CONVEX_URL }
  if (!force && fingerprint !== "unversioned") {
    try {
      const previous = JSON.parse(await readFile(stampPath, "utf8"))
      if (
        previous.fingerprint === stamp.fingerprint &&
        previous.convexUrl === stamp.convexUrl
      )
        return false
    } catch {
      // No earlier build.
    }
  }
  log("Building Blitz for production. This takes about a minute.")
  await runNextBuild(
    run,
    directory,
    nextBuildEnvironment(environment, buildEnvironment, CHECKOUT_DIST_DIR),
    undefined
  )
  await writeFile(stampPath, JSON.stringify(stamp))
  return true
}

/**
 * Fetches the tracked branch and builds, activates, and prunes releases in a Blitz home.
 * Running processes are not touched here; see `AutoUpdater` for the switch-over.
 */
export class ReleaseManager {
  /**
   * @param {{home: string, config: ServerConfig, environment?: NodeJS.ProcessEnv, run?: RunCommand, now?: () => Date}} options
   */
  constructor({
    home,
    config,
    environment = process.env,
    run = runCommand,
    now = () => new Date(),
  }) {
    this.home = home
    this.config = config
    this.paths = homePaths(home)
    this.environment = environment
    this.run = run
    this.now = now
  }

  /**
   * Runs Git against the bare release repository.
   * @param {string[]} args Git arguments after `--git-dir`.
   * @param {RunOptions} [options] Extra runner options.
   */
  git(args, options = {}) {
    return this.run("git", ["--git-dir", this.paths.repository, ...args], {
      env: this.environment,
      ...options,
    })
  }

  /**
   * Fetches the tracked branch from the repository named in `config.json`,
   * so editing that file is enough to follow another repository or branch.
   * @returns {Promise<string>} The branch's newest commit.
   * @throws When the network or repository is unavailable.
   */
  async fetchTarget() {
    const { branch, repository } = this.config
    await this.git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        repository,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { timeoutMs: 2 * 60_000 }
    )
    return (
      await this.git(["rev-parse", `refs/remotes/origin/${branch}^{commit}`])
    ).trim()
  }

  /**
   * Resolves any ref in the release repository to a commit.
   * @param {string} ref A branch, tag, or commit.
   */
  async resolveCommit(ref) {
    return (await this.git(["rev-parse", `${ref}^{commit}`])).trim()
  }

  /**
   * Reports whether a commit has the release runner, so serving it keeps updates working.
   * @param {string} commit The commit to inspect.
   */
  async canServe(commit) {
    try {
      await this.git(["cat-file", "-e", `${commit}:${RELEASE_MARKER}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * Checks out, installs, and builds one commit into a fresh release directory.
   * Nothing that is running is changed. A failed attempt is removed, and its
   * log is kept.
   * @param {string} commit The commit to build.
   * @param {BuildEnvironment} buildEnvironment The Convex URLs inlined into the browser bundle.
   * @returns {Promise<ReleaseMetadata & {directory: string, logPath: string}>}
   * @throws {ReleaseBuildError} With the build log's path.
   */
  async build(commit, buildEnvironment) {
    await mkdir(this.paths.releases, { recursive: true })
    await mkdir(this.paths.logs, { recursive: true })
    const stamp = this.now().toISOString().replace(/[-:]/g, "").slice(0, 15)
    const id = `${commit.slice(0, 12)}-${stamp}`
    const directory = join(this.paths.releases, id)
    const logPath = join(this.paths.logs, `build-${id}.log`)
    let stage = "check out the commit"
    // `prune` must not delete a release while it is being built.
    this.building = directory
    try {
      await this.git(["worktree", "add", "--detach", directory, commit], {
        logPath,
      })
      stage = "link the shared settings"
      await this.linkSharedFiles(directory)
      stage = "install dependencies"
      const lockfileHash = await this.installDependencies(directory, logPath)
      stage = "build the app"
      await runNextBuild(
        this.run,
        directory,
        nextBuildEnvironment(this.environment, buildEnvironment, undefined),
        logPath
      )
      /** @type {ReleaseMetadata} */
      const metadata = {
        commit,
        id,
        builtAt: this.now().toISOString(),
        convexUrl: buildEnvironment.NEXT_PUBLIC_CONVEX_URL ?? "",
        convexSiteUrl: buildEnvironment.NEXT_PUBLIC_CONVEX_SITE_URL,
        lockfileHash: lockfileHash ?? "",
      }
      await writeFile(join(directory, RELEASE_METADATA), JSON.stringify(metadata, null, 2))
      return { ...metadata, directory, logPath }
    } catch (error) {
      await this.remove(directory)
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error)
      throw new ReleaseBuildError(`Could not ${stage}: ${reason}`, logPath)
    } finally {
      this.building = undefined
      await this.pruneLogs()
    }
  }

  /**
   * Links `.env.local` and the local Convex state from the shared checkout, so
   * every release talks to the same database. The `.convex` folder is created
   * first when missing, so Convex never keeps a database inside a release that
   * will later be deleted.
   * @param {string} directory The new release.
   */
  async linkSharedFiles(directory) {
    const { sharedRoot } = this.config
    await mkdir(join(sharedRoot, ".convex"), { recursive: true })
    for (const name of SHARED_FILES) {
      const source = join(sharedRoot, name)
      if (!existsSync(source)) continue
      await rm(join(directory, name), { recursive: true, force: true })
      await symlink(source, join(directory, name))
    }
  }

  /**
   * Installs dependencies. When a kept release has the same lockfile, its
   * `node_modules` is cloned copy-on-write (APFS `cp -c`), which takes seconds
   * and almost no disk; otherwise `npm ci` runs.
   * @param {string} directory The new release.
   * @param {string} logPath The build log.
   * @returns {Promise<string | undefined>} The lockfile hash.
   */
  async installDependencies(directory, logPath) {
    const lockfileHash = await hashFile(join(directory, "package-lock.json"))
    for (const release of await this.listReleases()) {
      if (
        release.directory === directory ||
        release.lockfileHash !== lockfileHash ||
        !existsSync(join(release.directory, "node_modules"))
      )
        continue
      try {
        await this.run(
          "cp",
          ["-cR", join(release.directory, "node_modules"), join(directory, "node_modules")],
          { logPath, timeoutMs: 5 * 60_000 }
        )
        return lockfileHash
      } catch {
        // A failed clone falls back to a clean install below.
        await rm(join(directory, "node_modules"), { recursive: true, force: true })
      }
    }
    await this.run(
      "nice",
      ["-n", "10", "npm", "ci", "--no-audit", "--no-fund"],
      {
        cwd: directory,
        env: this.environment,
        logPath,
        timeoutMs: 15 * 60_000,
        label: "npm ci",
      }
    )
    return lockfileHash
  }

  /**
   * Points `current` at a finished release with an atomic rename, so readers
   * never see a missing link.
   * @param {string} directory The release to serve.
   */
  async activate(directory) {
    const pending = `${this.paths.current}.${process.pid}.pending`
    await rm(pending, { force: true })
    await symlink(directory, pending)
    await rename(pending, this.paths.current)
  }

  /**
   * Lists finished releases, newest first.
   * @returns {Promise<Array<ReleaseMetadata & {directory: string}>>}
   */
  async listReleases() {
    let names = []
    try {
      names = await readdir(this.paths.releases)
    } catch {
      return []
    }
    const releases = []
    for (const name of names) {
      const release = await readRelease(join(this.paths.releases, name))
      if (release) releases.push(release)
    }
    return releases.sort((left, right) => right.builtAt.localeCompare(left.builtAt))
  }

  /**
   * Deletes all but the newest kept releases, plus unfinished directories left
   * by an interrupted build. The release being served and any directory in
   * `keep` always survive.
   * @param {string[]} [keep] Directories still in use, such as the previous release.
   */
  async prune(keep = []) {
    const current = await currentRelease(this.home)
    const protectedDirectories = new Set(
      [current?.directory, ...keep].filter(Boolean).map((path) => resolve(path))
    )
    const finished = await this.listReleases()
    for (const release of finished.slice(0, KEPT_RELEASES))
      protectedDirectories.add(resolve(release.directory))
    let names = []
    try {
      names = await readdir(this.paths.releases)
    } catch {
      return
    }
    for (const name of names) {
      const directory = resolve(this.paths.releases, name)
      if (protectedDirectories.has(directory)) continue
      if (this.building === directory) continue
      await this.remove(directory)
    }
  }

  /**
   * Removes one release worktree, falling back to deleting the folder.
   * @param {string} directory The release to remove.
   */
  async remove(directory) {
    try {
      await this.git(["worktree", "remove", "--force", directory])
    } catch {
      // Not a registered worktree, or Git refused; delete the folder directly.
    }
    try {
      await lstat(directory)
      await rm(directory, { recursive: true, force: true })
    } catch {}
    await this.git(["worktree", "prune"]).catch(() => undefined)
  }

  /** Keeps only the newest build logs. */
  async pruneLogs() {
    let names = []
    try {
      names = (await readdir(this.paths.logs)).filter(
        (name) => name.startsWith("build-") && name.endsWith(".log")
      )
    } catch {
      return
    }
    // Names embed the build time after the commit, so sort on that part.
    const byTime = names.sort((left, right) =>
      right.slice(19).localeCompare(left.slice(19))
    )
    for (const name of byTime.slice(KEPT_BUILD_LOGS))
      await rm(join(this.paths.logs, name), { force: true })
  }

  /**
   * Pushes a release's Convex functions to the running local backend. The push
   * is atomic: if the schema does not match the stored data, nothing changes and
   * this throws, so the running release keeps working.
   * @param {string} directory The release whose `convex/` folder to push.
   * @param {string} convexUrl The running backend's loopback URL.
   * @param {string} [logPath] Where to append the output.
   */
  async pushConvexFunctions(directory, convexUrl, logPath) {
    const config = JSON.parse(
      await readFile(
        join(directory, ".convex", "local", "default", "config.json"),
        "utf8"
      )
    )
    if (typeof config?.adminKey !== "string")
      throw new Error("The local Convex deployment has no admin key.")
    await this.run(
      "node",
      [
        join("node_modules", "convex", "bin", "main.js"),
        "dev",
        "--once",
        "--typecheck",
        "disable",
        "--codegen",
        "disable",
        "--tail-logs",
        "disable",
        "--url",
        convexUrl,
        "--admin-key",
        config.adminKey,
      ],
      {
        cwd: directory,
        env: this.environment,
        logPath,
        timeoutMs: 5 * 60_000,
        label: "The Convex function push",
      }
    )
  }
}
