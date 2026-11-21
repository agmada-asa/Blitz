/**
 * Sets up and controls the Blitz background server (`npm run server -- <command>`).
 *
 * `install` creates the local database if there is none, then the Blitz home
 * (`~/.blitz`, or `BLITZ_HOME`; see `install-home.mjs`): a bare clone of the
 * repository, a first production release, and a per-user service (a
 * launchd agent on macOS, a systemd user unit on Linux) that
 * serves it on port 3007 and keeps it on the newest commit of `main`. Coding
 * in this checkout then never affects the running app. The other commands
 * report on and control that agent; see `docs/local-server.md`.
 */

import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readServerState,
  requestUpdate,
  shortCommit,
  waitForCheck,
} from "../electron/auto-update.mjs"
import {
  installService,
  isServerInstalled,
  serverProcess,
  serviceFilePath,
  startServer,
  stopServer,
  supportsBackgroundServer,
  uninstallService,
} from "../electron/background-server.mjs"
import { blitzHome, homePaths, readServerConfig } from "../electron/release-manager.mjs"
import { ensureLocalDatabase, mainCheckout, setUpHome } from "./install-home.mjs"

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

/**
 * Creates the local database if there is none, sets up the Blitz home with a
 * first release, and installs the service.
 */
async function install() {
  if (!supportsBackgroundServer())
    throw new Error("The background server runs on macOS and Linux only. On Windows, run npm run desktop:install and use the Blitz app, which updates itself while it's open.")
  const sharedRoot = resolve(option("shared-root") ?? mainCheckout(checkout))
  const port = Number(option("port") ?? process.env.BLITZ_PORT ?? 3007)
  await ensureLocalDatabase(sharedRoot)
  await setUpHome({
    home,
    checkout,
    sharedRoot,
    repository: option("repository"),
    branch: option("branch"),
    ref: option("ref"),
  })
  const config = await readServerConfig(home)

  await installService({
    home,
    nodePath: process.execPath,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BLITZ_PORT: String(port),
      ...(process.env.BLITZ_HOME ? { BLITZ_HOME: home } : {}),
    },
  })
  console.log(`Installed ${serviceFilePath()}. Waiting for Blitz to start…`)
  if (await waitForServer(port, 3 * 60_000))
    console.log(`Blitz is running at http://localhost:${port} and updates itself from ${config?.branch ?? "main"}.`)
  else
    console.log(
      `Blitz has not answered yet. If another Blitz is serving the database, stop it; the server starts when it can. Logs: ${join(paths.logs, "server.log")}`
    )
  if (process.platform === "linux")
    console.log(
      "To keep Blitz running while you are logged out, run loginctl enable-linger once."
    )
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
        ? "Loaded but not running; it will start again shortly."
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
    await uninstallService()
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
