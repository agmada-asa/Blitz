/**
 * Sets up and controls the Blitz background server (`npm run server -- <command>`).
 *
 * `install` creates the Blitz home (`~/.blitz`, or `BLITZ_HOME`): a bare clone
 * of the repository, a first production release, and a launchd agent that
 * serves it on port 3007 and keeps it on the newest commit of `main`. Coding
 * in this checkout then never affects the running app. The other commands
 * report on and control that agent; see `docs/local-server.md`.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readServerState,
  requestUpdate,
  shortCommit,
  waitForCheck,
} from "../electron/auto-update.mjs"
import {
  installLaunchAgent,
  isServerInstalled,
  launchAgentPath,
  serverProcess,
  startServer,
  stopServer,
  uninstallLaunchAgent,
} from "../electron/background-server.mjs"
import {
  blitzHome,
  currentRelease,
  homePaths,
  readServerConfig,
  ReleaseManager,
} from "../electron/release-manager.mjs"

const checkout = fileURLToPath(new URL("..", import.meta.url))
const home = blitzHome()
const paths = homePaths(home)
const [command = "status", ...rest] = process.argv.slice(2)

/**
 * Returns the value after a `--name` flag.
 * @param {string} name The flag without dashes.
 */
function option(name) {
  const index = rest.indexOf(`--${name}`)
  return index === -1 ? undefined : rest[index + 1]
}

/**
 * Runs Git in this checkout and returns its trimmed output.
 * @param {string[]} args Git arguments.
 */
function git(args) {
  return execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim()
}

/**
 * Turns an SSH GitHub remote into HTTPS, which a public repository can fetch
 * from without keys; launchd has no SSH agent.
 * @param {string} url The remote URL.
 */
function fetchableUrl(url) {
  const ssh = url.match(/^git@github\.com:(.+)$/)
  return ssh ? `https://github.com/${ssh[1]}` : url
}

/**
 * Waits until the server answers its health route.
 * @param {number} port The web port.
 * @param {number} timeoutMs How long to wait.
 */
async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return true
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  return false
}

/** Creates the Blitz home, builds the first release, and installs the launchd agent. */
async function install() {
  if (process.platform !== "darwin")
    throw new Error("The background server uses launchd, so it runs on macOS only.")
  const commonDirectory = resolve(checkout, git(["rev-parse", "--git-common-dir"]))
  // The main checkout, even when this command runs from a linked worktree.
  const sharedRoot = resolve(option("shared-root") ?? dirname(commonDirectory))
  const convexConfigPath = join(sharedRoot, ".convex", "local", "default", "config.json")
  if (!existsSync(join(sharedRoot, ".env.local")) || !existsSync(convexConfigPath))
    throw new Error(
      `${sharedRoot} has no local Convex database yet. Run npm run dev:lan -- --dev there once, stop it, then install again.`
    )
  const port = Number(option("port") ?? process.env.BLITZ_PORT ?? 3007)
  const config = {
    repository: option("repository") ?? fetchableUrl(git(["remote", "get-url", "origin"])),
    branch: option("branch") ?? "main",
    sharedRoot,
  }
  await mkdir(home, { recursive: true })
  await writeFile(paths.config, JSON.stringify(config, null, 2))

  if (!existsSync(paths.repository)) {
    console.log(`Cloning the repository into ${paths.repository}…`)
    execFileSync("git", ["clone", "--bare", "--quiet", "--no-tags", commonDirectory, paths.repository])
  }
  execFileSync("git", ["--git-dir", paths.repository, "remote", "set-url", "origin", config.repository])

  const releases = new ReleaseManager({ home, config })
  const ref = option("ref")
  let commit
  if (ref) {
    // A local branch that is not on GitHub yet, such as one under review.
    await releases.git(["fetch", "--quiet", "--no-tags", commonDirectory, `+${ref}:refs/blitz/install`])
    commit = await releases.resolveCommit("refs/blitz/install")
  } else {
    commit = await releases.fetchTarget()
  }
  if (!(await releases.canServe(commit)))
    throw new Error(
      `${ref ?? config.branch} (${shortCommit(commit)}) does not include the Blitz server yet. Install from a branch that does with --ref <branch>.`
    )

  const { ports } = JSON.parse(await readFile(convexConfigPath, "utf8"))
  const buildEnvironment = {
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${ports.cloud}`,
    NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${ports.site}`,
  }
  const current = await currentRelease(home)
  if (
    current?.commit === commit &&
    current.convexUrl === buildEnvironment.NEXT_PUBLIC_CONVEX_URL
  ) {
    console.log(`Release ${shortCommit(commit)} is already built.`)
  } else {
    console.log(`Building Blitz ${shortCommit(commit)}. This takes about a minute…`)
    const built = await releases.build(commit, buildEnvironment)
    await releases.activate(built.directory)
    console.log(`Built ${built.directory}`)
  }

  await installLaunchAgent({
    home,
    nodePath: process.execPath,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BLITZ_PORT: String(port),
      ...(process.env.BLITZ_HOME ? { BLITZ_HOME: home } : {}),
    },
  })
  console.log(`Installed ${launchAgentPath()}. Waiting for Blitz to start…`)
  if (await waitForServer(port, 3 * 60_000))
    console.log(`Blitz is running at http://localhost:${port} and updates itself from ${config.branch}.`)
  else
    console.log(
      `Blitz has not answered yet. If another Blitz is serving the database, stop it; the server starts when it can. Logs: ${join(paths.logs, "server.log")}`
    )
  console.log("Run npm run desktop:install so Blitz.app opens this server.")
}

/** Prints the server's process, release, and last update check. */
async function status() {
  if (!isServerInstalled()) {
    console.log("The Blitz server is not installed. Run npm run server -- install.")
    return
  }
  const [process_, state, config] = await Promise.all([
    serverProcess(),
    readServerState(home),
    readServerConfig(home),
  ])
  console.log(
    process_.pid
      ? `Running (pid ${process_.pid}) on port ${state?.port ?? "?"}`
      : process_.loaded
        ? "Loaded but not running; launchd will start it again shortly."
        : "Stopped. Start it with npm run server -- start."
  )
  if (state?.release)
    console.log(`Release: ${shortCommit(state.release.commit)}, built ${state.release.builtAt}`)
  if (config) console.log(`Updates from: ${config.branch} at ${config.repository}`)
  if (state?.phase) console.log(`Now: ${state.phase.name}${state.phase.target ? ` ${shortCommit(state.phase.target)}` : ""}`)
  if (state?.lastCheck)
    console.log(`Last check (${state.lastCheck.at}): ${state.lastCheck.message}`)
  if (state?.failure)
    console.log(
      `Last failure: ${state.failure.message}${state.failure.logPath ? `\n  Log: ${state.failure.logPath}` : ""}`
    )
  console.log(`Logs: ${paths.logs}`)
}

/**
 * Asks the running server to check for updates or rebuild, and prints the outcome.
 * @param {"check" | "rebuild"} action What to ask for.
 */
async function update(action) {
  const requestId = await requestUpdate(home, action)
  console.log(action === "rebuild" ? "Rebuilding Blitz…" : "Checking for updates…")
  const result = await waitForCheck(home, requestId)
  console.log(result.message)
  if (result.logPath) console.log(`Build log: ${result.logPath}`)
  if (result.status === "failed") process.exitCode = 1
}

const commands = {
  install,
  status,
  check: () => update("check"),
  rebuild: () => update("rebuild"),
  start: async () => {
    await startServer()
    console.log("Started the Blitz server.")
  },
  stop: async () => {
    await stopServer()
    console.log("Stopped the Blitz server. It starts again at login, or with npm run server -- start.")
  },
  uninstall: async () => {
    await uninstallLaunchAgent()
    console.log(`Removed the Blitz server. Releases and logs remain in ${home}.`)
  },
}

if (!Object.hasOwn(commands, command)) {
  console.error(
    `Unknown command ${command}. Use install, status, check, rebuild, start, stop, or uninstall.`
  )
  process.exitCode = 1
} else {
  await commands[command]().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
