/**
 * Starts the local web app, database, and background worker for this Mac and the LAN.
 *
 * Three modes share the supervisor in `electron/service-manager.mjs`, so a
 * crashed worker or server restarts with backoff instead of taking the stack down:
 *
 * - `npm run dev:lan`: production. When the background server is installed
 *   (`npm run server -- install`) it is already serving, so this only prints
 *   where to open Blitz. Otherwise it builds this checkout once into
 *   `.next-production` (again only after the code changes) and runs `next start`.
 * - `npm run dev:lan -- --dev`: `next dev` from this checkout, for coding. If a
 *   Blitz server already holds the database, Next starts on port 3009 against
 *   it and does not push this checkout's Convex functions.
 * - `--service`: the background server's launchd entry. It serves
 *   `~/.blitz/current` and keeps it on the newest tracked commit
 *   (`electron/auto-update.mjs`).
 *
 * Without a network connection Blitz still runs on this Mac; phone access needs Wi-Fi.
 */

import { networkInterfaces } from "node:os"
import { isIP } from "node:net"
import { closeSync, copyFileSync, openSync, renameSync, statSync, truncateSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { formatTerminalQr } from "./lan-qr.mjs"
import { AutoUpdater, CHECK_INTERVAL_MS, readServerState, shortCommit } from "../electron/auto-update.mjs"
import { isServerInstalled, RESTART_EXIT_CODE, serverProcess, startServer } from "../electron/background-server.mjs"
import { loadLoginEnvironment } from "../electron/login-environment.mjs"
import {
  blitzHome,
  buildCheckout,
  CHECKOUT_DIST_DIR,
  homePaths,
  readServerConfig,
  ReleaseManager,
} from "../electron/release-manager.mjs"
import { DatabaseInUseError, ServiceManager } from "../electron/service-manager.mjs"

/** Service output above this size is moved aside, keeping one older copy. */
const SERVICE_LOG_LIMIT_BYTES = 20 * 1024 * 1024

const mode = process.argv.includes("--service")
  ? "service"
  : process.argv.includes("--dev")
    ? "dev"
    : "production"
const checkout = fileURLToPath(new URL("..", import.meta.url))
const configuredPort = Number(process.env.BLITZ_PORT ?? "3007")
const home = blitzHome()

if (mode === "service")
  // launchd starts the server with almost no environment; recover the login
  // shell's PATH so Node, Git, the provider CLIs, and Tailscale are found.
  Object.assign(process.env, await loadLoginEnvironment().catch(() => ({})))

const configuredLanAddress = process.env.BLITZ_LAN_ADDRESS?.trim()
const lanAddress =
  configuredLanAddress && isIP(configuredLanAddress) === 4
    ? configuredLanAddress
    : findLanAddress()
const environment = {
  ...process.env,
  ...(lanAddress ? { BLITZ_LAN_ADDRESS: lanAddress } : {}),
}

/** @type {ServiceManager | undefined} */
let services
let stopping = false
process.on("SIGINT", () => void stop(0))
process.on("SIGTERM", () => void stop(0))
process.on("SIGHUP", () => void stop(129))
process.once("exit", () => services?.killNow())

try {
  if (mode === "service") await runService()
  else if (mode === "dev") await runDevelopment()
  else await runProduction()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  await stop(1)
}

/**
 * Serves this checkout's production build, or points at the background server
 * when it is installed.
 */
async function runProduction() {
  if (isServerInstalled()) {
    const state = await readServerState(home)
    if (!(await serverProcess()).pid) await startServer()
    const port = state?.port ?? configuredPort
    console.log(
      `\nBlitz runs in the background${state?.release ? ` (${shortCommit(state.release.commit)})` : ""} and updates itself from ${state?.branch ?? "main"}.`
    )
    await printAddresses(port)
    console.log(
      "Use npm run server -- status to see its state, or npm run dev:lan -- --dev to work on this checkout.\n"
    )
    process.exit(0)
  }
  services = new ServiceManager({
    cwd: checkout,
    port: configuredPort,
    host: "0.0.0.0",
    desktop: false,
    production: true,
    distDir: CHECKOUT_DIST_DIR,
    pidFile: join(homePaths(home).run, "lan-services.json"),
    environment,
    onStatus: reportStatus,
  })
  await services.reapOrphans()
  const serviceEnvironment = await services.prepareEnvironment()
  await buildCheckout(
    checkout,
    {
      NEXT_PUBLIC_CONVEX_URL: serviceEnvironment.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_SITE_URL: serviceEnvironment.NEXT_PUBLIC_CONVEX_SITE_URL,
    },
    {
      environment,
      force: process.argv.includes("--rebuild"),
      log: (message) => console.log(message),
    }
  )
  await printAddresses(configuredPort)
  await services.start()
  console.log(`\nBlitz is ready at http://localhost:${configuredPort}\n`)
}

/**
 * Runs `next dev` from this checkout. When another Blitz already serves the
 * database, only Next starts, on its own port, against that database.
 */
async function runDevelopment() {
  const options = {
    cwd: checkout,
    host: "0.0.0.0",
    desktop: false,
    pidFile: join(homePaths(home).run, "dev-services.json"),
    onStatus: reportStatus,
  }
  services = new ServiceManager({ ...options, port: configuredPort, environment })
  await services.reapOrphans()
  try {
    await services.prepareEnvironment()
  } catch (error) {
    if (!(error instanceof DatabaseInUseError)) throw error
    const port = Number(process.env.BLITZ_PORT ?? "3009")
    console.log(
      `\nAnother Blitz is serving the database, so only Next starts here, on port ${port}.` +
        "\nThis checkout's Convex functions are not pushed; stop the other server to work on them (npm run server -- stop)."
    )
    services = new ServiceManager({
      ...options,
      port,
      environment: {
        ...environment,
        BLITZ_DESKTOP_SKIP_CONVEX: "1",
        BLITZ_DESKTOP_SKIP_WORKERS: "1",
      },
    })
  }
  await printAddresses(services.port)
  await services.start()
  console.log(`\nBlitz is ready at http://localhost:${services.port}\n`)
}

/**
 * Runs the background server: serves the current release, checks for updates,
 * and waits instead of exiting when something blocks it, so launchd does not
 * restart it in a tight loop.
 */
async function runService() {
  const config = await readServerConfig(home)
  if (!config)
    throw new Error("The Blitz server is not set up. Run npm run server -- install from a checkout.")
  const paths = homePaths(home)
  const log = await openServiceLog(paths.logs)
  services = new ServiceManager({
    cwd: paths.current,
    port: configuredPort,
    host: "0.0.0.0",
    desktop: false,
    production: true,
    pidFile: join(paths.run, "server-services.json"),
    environment,
    stdio: ["ignore", log.fd, log.fd],
    onStatus: reportStatus,
  })
  // Builds report their process groups to the supervisor, so a crash
  // mid-build does not leave them running past the next start.
  const releases = new ReleaseManager({ home, config, environment, processes: services })
  const updater = new AutoUpdater({
    releases,
    services,
    home,
    host: "server",
    onRunnerChanged: () => void restartForNewRunner(),
  })
  // Before `prepare` publishes this process's ID, so a request never meets a
  // process without a handler, which `SIGUSR2` would end.
  updater.listenForRequests()
  await services.reapOrphans()
  for (;;) {
    try {
      const release = await updater.prepare()
      console.log(`[blitz] Serving ${shortCommit(release.commit)} from ${release.directory}`)
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const waitMs = error instanceof DatabaseInUseError ? 30_000 : CHECK_INTERVAL_MS
      console.error(`[blitz] ${message} Trying again in ${Math.round(waitMs / 60_000) || 0.5} min, or sooner when asked to check.`)
      updater.state.failure = { message, at: new Date().toISOString() }
      await updater.failWaitingRequests(message)
      await updater.writeState()
      await updater.waitForRequest(waitMs)
      if (stopping) return
    }
  }
  await services.start()
  updater.start()
  setInterval(() => log.rotate(), 60 * 60_000).unref()
  console.log(`[blitz] Ready at http://localhost:${configuredPort}`)
}

/**
 * Stops the stack and exits so launchd starts the server again, now running
 * the updater and supervisor code from the new release.
 */
async function restartForNewRunner() {
  console.log("[blitz] The update changed the Blitz server itself, so it is restarting.")
  await stop(RESTART_EXIT_CODE)
}

/**
 * Opens the services' shared log for appending. A large log is moved aside at
 * launch, and `rotate` copies and truncates it later: the services keep their
 * append-mode descriptor, so they continue at the start of the emptied file.
 * @param {string} directory The logs folder.
 */
async function openServiceLog(directory) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, "services.log")
  const previous = `${path}.previous`
  /** Returns the log's size, or zero when it does not exist. */
  const size = () => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }
  if (size() > SERVICE_LOG_LIMIT_BYTES) renameSync(path, previous)
  const fd = openSync(path, "a")
  return {
    fd,
    /** Keeps the log bounded while services are writing to it. */
    rotate() {
      if (size() <= SERVICE_LOG_LIMIT_BYTES) return
      try {
        copyFileSync(path, previous)
        truncateSync(path, 0)
      } catch {}
    },
    close: () => closeSync(fd),
  }
}

/**
 * Prints the addresses Blitz answers on, with a QR code for the LAN address.
 * @param {number} port The web port.
 */
async function printAddresses(port) {
  console.log(`\nBlitz will be available on this Mac at http://localhost:${port}`)
  if (!lanAddress) {
    console.log(
      "No Wi-Fi address found, so phones cannot connect. Blitz still runs on this Mac.\n"
    )
    return
  }
  const lanUrl = `http://${lanAddress}:${port}`
  console.log(
    `Open ${lanUrl} on a phone connected to the same Wi-Fi or scan the QR code:\n`
  )
  try {
    console.log(await formatTerminalQr(lanUrl))
    console.log()
  } catch (error) {
    console.error("Could not render QR code for terminal:", error)
  }
}

/** Returns the first external IPv4 address, or undefined when no LAN is available. */
function findLanAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address
    }
  }
}

/** Prints restarts and recoveries so a crash is visible without stopping Blitz. */
function reportStatus(name, status) {
  if (status.state === "restarting") {
    const seconds = Math.max(
      0,
      Math.round(((status.nextRestartAt ?? Date.now()) - Date.now()) / 1000)
    )
    console.error(
      `[blitz] ${name} stopped (${status.lastExit}). Restarting in ${seconds}s.`
    )
  } else if (status.state === "running" && status.restarts > 0) {
    console.log(`[blitz] ${name} restarted.`)
  }
}

/** Stops every supervised service once, then exits with the given code. */
async function stop(exitCode) {
  if (stopping) process.exit(exitCode)
  stopping = true
  await services?.stop()
  process.exit(exitCode)
}
