/**
 * Starts the local web app, database, and background worker for this computer and the LAN.
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
 *   it and does not push this checkout's Convex functions. Service output goes
 *   to `~/.blitz/logs/dev.log`; the terminal shows the address, errors, and
 *   restarts, and the browser opens when Blitz is ready. `--verbose` streams
 *   everything to the terminal instead, and `--no-open` (or `BLITZ_OPEN=0`)
 *   keeps the browser closed.
 * - `--service`: the background server's launchd entry. It serves
 *   `~/.blitz/current` and keeps it on the newest tracked commit
 *   (`electron/auto-update.mjs`).
 *
 * Without a network connection Blitz still runs on this computer; phone access needs Wi-Fi.
 */

import { createSocket } from "node:dgram"
import { networkInterfaces } from "node:os"
import { isIP } from "node:net"
import {
  closeSync,
  copyFileSync,
  fstatSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createProblemFilter, displayPath, followLog, openInBrowser, tailLog } from "./dev-console.mjs"
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
/** In dev mode, streams every service's output to the terminal instead of `dev.log`. */
const verbose = process.argv.includes("--verbose")
/** In dev mode, opens the browser once Blitz is ready, unless asked not to or not run from a terminal. */
const openBrowser =
  Boolean(process.stdout.isTTY) &&
  !process.argv.includes("--no-open") &&
  process.env.BLITZ_OPEN !== "0"
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
    : await findLanAddress()
const environment = {
  ...process.env,
  ...(lanAddress ? { BLITZ_LAN_ADDRESS: lanAddress } : {}),
}

/** @type {ServiceManager | undefined} */
let services
/** The log quiet dev mode writes service output to, named in restart messages. */
let quietLogPath = ""
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
 *
 * Unless `--verbose` is passed, service output is appended to
 * `~/.blitz/logs/dev.log` and the terminal shows only a start message, the
 * address, problem lines from the log, and restarts. A failed start prints
 * the end of this run's log before the error.
 */
async function runDevelopment() {
  const log = verbose ? undefined : await openServiceLog(homePaths(home).logs, "dev.log")
  let logStart = 0
  if (log) {
    // Runs share one log; the marker and offset separate this run's output.
    writeSync(log.fd, `\n--- npm run dev started ${new Date().toISOString()} ---\n`)
    logStart = fstatSync(log.fd).size
    quietLogPath = log.path
    setInterval(() => log.rotate(), 60 * 60_000).unref()
    console.log("\nStarting Blitz…")
  }
  const options = {
    cwd: checkout,
    host: "0.0.0.0",
    desktop: false,
    pidFile: join(homePaths(home).run, "dev-services.json"),
    onStatus: reportStatus,
    ...(log ? { stdio: /** @type {import("node:child_process").StdioOptions} */ (["ignore", log.fd, log.fd]) } : {}),
  }
  services = new ServiceManager({ ...options, port: configuredPort, environment })
  await services.reapOrphans()
  let attached = false
  try {
    await services.prepareEnvironment()
  } catch (error) {
    if (!(error instanceof DatabaseInUseError)) throw error
    attached = true
    const port = Number(process.env.BLITZ_PORT ?? "3009")
    if (verbose)
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
  const url = `http://localhost:${services.port}`
  if (!log) {
    await printAddresses(services.port)
    await services.start()
    console.log(`\nBlitz is ready at ${url}\n`)
    return
  }

  // Errors keep reaching the terminal, including Convex push failures that
  // would otherwise only show up as missing functions in the app.
  const showProblem = createProblemFilter()
  const stopFollowing = followLog(log.path, logStart, (line) => {
    const text = showProblem(line)
    if (text) console.error(`  ${text}`)
  })
  try {
    await services.start()
  } catch (error) {
    stopFollowing()
    const tail = tailLog(log.path, logStart)
    if (tail.length) console.error(`\nLast lines of ${displayPath(log.path)}:\n${tail.map((line) => `  ${line}`).join("\n")}\n`)
    console.error("Run npm run dev -- --verbose to see all output as it happens.")
    throw error
  }
  console.log(`\nBlitz has started: ${url}`)
  if (lanAddress) console.log(`On a phone on the same Wi-Fi: http://${lanAddress}:${services.port}`)
  if (attached)
    console.log(
      "Using the database of the Blitz server that is already running, so changes in convex/ are not pushed. Stop it with npm run server -- stop to work on them."
    )
  console.log(`Logs are in ${displayPath(log.path)}. Press Ctrl+C to stop.\n`)
  if (openBrowser) openInBrowser(url)
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
 * @param {string} [name] The log's file name.
 */
async function openServiceLog(directory, name = "services.log") {
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
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
    path,
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
  console.log(`\nBlitz will be available on this computer at http://localhost:${port}`)
  if (!lanAddress) {
    console.log(
      "No Wi-Fi address found, so phones cannot connect. Blitz still runs on this computer.\n"
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

/**
 * Returns the IPv4 address a phone on the same network can reach, or undefined
 * when no LAN is available.
 *
 * Prefers the interface carrying the default route, so virtual adapters
 * (VirtualBox, Hyper-V, WSL, VPNs) that are listed before Wi-Fi are not
 * chosen. Offline, falls back to the first external, non-link-local address.
 */
async function findLanAddress() {
  const routed = await defaultRouteAddress()
  if (routed) return routed
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        !address.address.startsWith("169.254.")
      )
        return address.address
    }
  }
}

/**
 * Asks the operating system which local address it would send internet
 * traffic from. Connecting a UDP socket only selects a route; no packet is
 * sent, so this works without contacting the address.
 * @returns {Promise<string | undefined>} The address, or undefined when there
 *   is no default route or it is not a usable IPv4 address.
 */
function defaultRouteAddress() {
  return new Promise((resolvePromise) => {
    const socket = createSocket("udp4")
    /** Closes the socket once and reports the outcome. */
    const finish = (address) => {
      socket.close()
      resolvePromise(address)
    }
    socket.once("error", () => finish(undefined))
    // Offline, the failure arrives here rather than as an `error` event, and
    // the socket may not be bound, so `address()` could throw.
    socket.connect(53, "8.8.8.8", (error) => {
      if (error) return finish(undefined)
      try {
        const { address } = socket.address()
        const usable = address && address !== "0.0.0.0" && !address.startsWith("169.254.")
        finish(usable ? address : undefined)
      } catch {
        finish(undefined)
      }
    })
  })
}

/** Prints restarts and recoveries so a crash is visible without stopping Blitz. */
function reportStatus(name, status) {
  if (status.state === "restarting") {
    const seconds = Math.max(
      0,
      Math.round(((status.nextRestartAt ?? Date.now()) - Date.now()) / 1000)
    )
    console.error(
      `[blitz] ${name} stopped (${status.lastExit}). Restarting in ${seconds}s.` +
        (quietLogPath ? ` Details are in ${displayPath(quietLogPath)}.` : "")
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
