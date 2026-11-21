/**
 * Prepares what every installed Blitz runs from: the local database and the
 * Blitz home with a first release. `npm run desktop:install` and
 * `npm run server -- install` both start here, so neither needs another
 * command run first.
 *
 * - `ensureLocalDatabase` creates the checkout's local Convex database when it
 *   has none, the way the first `npm run dev` would, and stops it again.
 * - `setUpHome` writes `config.json` in the Blitz home (see
 *   `electron/release-manager.mjs`), clones the repository, and builds and
 *   activates the first release. A home that already has a release for this
 *   database is left as it is, so installing again never fights a running
 *   updater.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { shortCommit } from "../electron/auto-update.mjs"
import {
  currentRelease,
  homePaths,
  readServerConfig,
  ReleaseManager,
  runCommand,
} from "../electron/release-manager.mjs"
import { resolveLocalConvexPorts } from "../electron/service-manager.mjs"

/**
 * Returns the main checkout of the repository `checkout` belongs to, even
 * when `checkout` is a linked worktree. Its `.env.local` and `.convex` hold
 * the database every release uses.
 * @param {string} checkout Any working tree of the repository.
 */
export function mainCheckout(checkout) {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim()
  return dirname(resolve(checkout, common))
}

/**
 * Turns an SSH GitHub remote into HTTPS, which a public repository can be
 * fetched from without keys; the updater runs without an SSH agent.
 * @param {string} url The remote URL.
 */
export function fetchableUrl(url) {
  const ssh = url.match(/^git@github\.com:(.+)$/)
  return ssh ? `https://github.com/${ssh[1]}` : url
}

/**
 * Returns the path of the saved local Convex deployment in a checkout.
 * @param {string} root The checkout.
 */
function convexConfigPath(root) {
  return join(root, ".convex", "local", "default", "config.json")
}

/**
 * Creates the local Convex database in `sharedRoot` when it has none: the
 * CLI starts a local backend on Blitz's port pair, pushes the functions once,
 * writes `.env.local` and `.convex/local/default`, and stops. Anonymous mode
 * keeps the database on this computer even when the Convex CLI is signed in
 * to an account, where it would otherwise offer to create a cloud project.
 * @param {string} sharedRoot The main checkout, with its dependencies installed.
 * @param {{log?: (message: string) => void}} [options]
 * @returns {Promise<boolean>} Whether a database was created.
 * @throws When `.env.local` names a Convex cloud or self-hosted deployment,
 *   which `convex dev` would push to instead of making a local database, or
 *   when the Convex CLI fails; its output ends the message.
 */
export async function ensureLocalDatabase(sharedRoot, { log = console.log } = {}) {
  const envPath = join(sharedRoot, ".env.local")
  if (existsSync(envPath) && existsSync(convexConfigPath(sharedRoot))) return false
  // Anonymous mode only decides what an unconfigured checkout gets; a
  // configured cloud deployment would still receive this checkout's functions.
  const settings = existsSync(envPath) ? await readFile(envPath, "utf8") : ""
  if (/^\s*CONVEX_DEPLOYMENT\s*=\s*["']?(dev|prod|preview):/m.test(settings) || /^\s*CONVEX_SELF_HOSTED_URL\s*=/m.test(settings))
    throw new Error(
      `${envPath} points at a Convex deployment that isn't on this computer. Blitz installs run on a local database: remove its CONVEX_DEPLOYMENT and CONVEX_SELF_HOSTED_URL lines, then install again.`
    )
  const cli = join(sharedRoot, "node_modules", "convex", "bin", "main.js")
  if (!existsSync(cli))
    throw new Error(`${sharedRoot} has no dependencies installed. Run npm ci there first.`)
  const ports = await resolveLocalConvexPorts(sharedRoot)
  log("Creating the local database…")
  await runCommand(
    process.execPath,
    [
      cli,
      "dev",
      "--once",
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
      "--tail-logs",
      "disable",
      "--local-cloud-port",
      String(ports.cloud),
      "--local-site-port",
      String(ports.site),
    ],
    {
      cwd: sharedRoot,
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      timeoutMs: 5 * 60_000,
      label: "Creating the local database",
    }
  )
  if (!existsSync(convexConfigPath(sharedRoot)))
    throw new Error(`Convex finished without saving a local database in ${sharedRoot}.`)
  return true
}

/**
 * Sets up the Blitz home and makes sure `current` is a release built for this
 * database. An existing `config.json` is kept, so a home that follows another
 * repository or branch keeps doing so, unless `repository` or `branch` is given.
 * Its database is kept too, unless that database no longer exists; then the
 * home switches to `sharedRoot` and builds a release that links it.
 * @param {{
 *   home: string,
 *   checkout: string,
 *   sharedRoot: string,
 *   repository?: string,
 *   branch?: string,
 *   ref?: string,
 *   log?: (message: string) => void,
 * }} options `checkout` is where this command runs; `sharedRoot` holds the
 *   database. `ref` installs a local branch or commit that may not be on the
 *   remote yet, such as one under review.
 * @returns {Promise<import("../electron/release-manager.mjs").ReleaseMetadata & {directory: string}>} The release `current` points at.
 * @throws When the database is missing, Git fails, or the build fails.
 */
export async function setUpHome({
  home,
  checkout,
  sharedRoot,
  repository,
  branch,
  ref,
  log = console.log,
}) {
  const paths = homePaths(home)
  const commonDirectory = resolve(
    checkout,
    execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: checkout, encoding: "utf8" }).trim()
  )
  const saved = await readServerConfig(home)
  // A saved database that is gone, such as a deleted or moved checkout, gives
  // way to this one; the release built for it links the missing folder, so
  // a new one is built below.
  const savedDatabaseMissing =
    saved !== undefined && !existsSync(convexConfigPath(saved.sharedRoot))
  if (savedDatabaseMissing)
    log(`The database this Blitz home used in ${saved.sharedRoot} is gone, so it now uses ${sharedRoot}.`)
  const config = {
    repository:
      repository ??
      saved?.repository ??
      fetchableUrl(
        execFileSync("git", ["remote", "get-url", "origin"], { cwd: checkout, encoding: "utf8" }).trim()
      ),
    branch: branch ?? saved?.branch ?? "main",
    sharedRoot: savedDatabaseMissing ? sharedRoot : (saved?.sharedRoot ?? sharedRoot),
  }
  if (resolve(config.sharedRoot) !== resolve(sharedRoot))
    log(`This Blitz home already uses the database in ${config.sharedRoot}, so it keeps that one.`)
  await mkdir(home, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config, null, 2))

  if (!existsSync(paths.repository)) {
    log(`Cloning the repository into ${paths.repository}…`)
    execFileSync("git", ["clone", "--bare", "--quiet", "--no-tags", commonDirectory, paths.repository])
  }
  execFileSync("git", ["--git-dir", paths.repository, "remote", "set-url", "origin", config.repository])

  const { ports } = JSON.parse(await readFile(convexConfigPath(config.sharedRoot), "utf8"))
  const buildEnvironment = {
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${ports.cloud}`,
    NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${ports.site}`,
  }
  const current = await currentRelease(home)
  // A release built for this database, unless it links a database that is gone.
  const currentFits =
    current !== undefined &&
    !savedDatabaseMissing &&
    current.convexUrl === buildEnvironment.NEXT_PUBLIC_CONVEX_URL
  // Without a ref, any release built for this database will do: the updater
  // moves it to the newest commit on its own, and it may be running right now.
  if (!ref && current && currentFits) {
    log(`Blitz ${shortCommit(current.commit)} is already built.`)
    return current
  }

  const releases = new ReleaseManager({ home, config })
  let commit
  if (ref) {
    await releases.git(["fetch", "--quiet", "--no-tags", commonDirectory, `+${ref}:refs/blitz/install`])
    commit = await releases.resolveCommit("refs/blitz/install")
  } else {
    commit = await releases.fetchTarget()
  }
  if (!(await releases.canServe(commit)))
    throw new Error(
      `${ref ?? config.branch} (${shortCommit(commit)}) does not include the Blitz server yet. Install from a branch that does with --ref <branch>.`
    )
  if (current && currentFits && current.commit === commit) {
    log(`Blitz ${shortCommit(commit)} is already built.`)
    return current
  }
  log(`Building Blitz ${shortCommit(commit)}. This takes a few minutes the first time…`)
  const built = await releases.build(commit, buildEnvironment)
  await releases.activate(built.directory)
  await releases.prune()
  return built
}
