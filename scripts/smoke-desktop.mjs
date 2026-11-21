/**
 * Opens the desktop app `npm run desktop:install` installed and checks it
 * end to end: the app starts the local services from the release in the
 * Blitz home, a project can be saved and read back, and its page is served.
 * It also checks the app was registered where each system looks for apps and
 * `blitz://` links. CI runs it on macOS, Windows, and Linux after the
 * install, so a change that breaks installing or opening the app fails a
 * check instead of a friend's first try.
 *
 * Usage: node scripts/smoke-desktop.mjs (on Linux CI, under `xvfb-run`)
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { blitzHome, homePaths } from "../electron/release-manager.mjs"

/** The port the app serves on when it hosts the services itself. */
const DESKTOP_PORT = 3008
const READY_TIMEOUT_MS = 10 * 60_000
const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
const roamingAppData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")

/** Per platform: the installed program, the files that register it, and its log. */
const installs = {
  darwin: {
    executable: join(homedir(), "Applications", "Blitz.app", "Contents", "MacOS", "Blitz"),
    registered: [],
    log: join(homedir(), "Library", "Logs", "Blitz", "blitz.log"),
  },
  win32: {
    executable: join(localAppData, "Programs", "Blitz", "Blitz.exe"),
    registered: [join(roamingAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Blitz.lnk")],
    log: join(roamingAppData, "Blitz", "logs", "blitz.log"),
  },
  linux: {
    executable: join(dataHome, "blitz", "app", "blitz"),
    registered: [
      join(dataHome, "applications", "dev.blitz.Blitz.desktop"),
      join(dataHome, "icons", "hicolor", "512x512", "apps", "dev.blitz.Blitz.png"),
    ],
    log: join(homedir(), ".config", "Blitz", "logs", "blitz.log"),
  },
}
const install = installs[/** @type {keyof typeof installs} */ (process.platform)]
if (!install) throw new Error(`No desktop app on ${process.platform}.`)

let exitCode = 1
/** @type {import("node:child_process").ChildProcess | undefined} */
let app
try {
  for (const path of [install.executable, ...install.registered])
    if (!existsSync(path)) throw new Error(`The install is missing ${path}.`)
  if (process.platform === "win32") {
    const command = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Classes\\blitz\\shell\\open\\command", "/ve"],
      { encoding: "utf8" }
    )
    if (!command.includes(install.executable))
      throw new Error(`blitz:// links do not open the installed app:\n${command}`)
  }

  app = spawn(install.executable, [], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  })
  app.once("exit", (code, signal) => {
    if (exitCode !== 0) console.error(`[smoke] The app exited (${signal ?? code}).`)
  })
  const origin = `http://127.0.0.1:${DESKTOP_PORT}`
  await waitFor(`${origin}/api/health`)

  // The app serves the release, which links the checkout's database.
  const current = homePaths(blitzHome()).current
  const config = JSON.parse(
    readFileSync(join(current, ".convex", "local", "default", "config.json"), "utf8")
  )
  const convexUrl = `http://127.0.0.1:${config.ports.cloud}`
  const projectId = await convex(convexUrl, "mutation", "projects:createProject", {
    title: "Desktop smoke test",
  })
  const project = await convex(convexUrl, "query", "projects:getProject", { projectId })
  if (project?.title !== "Desktop smoke test")
    throw new Error(`The new project read back as ${JSON.stringify(project)}.`)
  const page = await fetch(`${origin}/projects/${projectId}`)
  if (!page.ok) throw new Error(`The project page answered ${page.status}.`)
  console.log(`\n[smoke] The installed app started Blitz, saved project ${projectId} and served its page.`)
  exitCode = 0
} catch (error) {
  console.error(`\n[smoke] ${error instanceof Error ? error.message : error}`)
  try {
    const log = readFileSync(install.log, "utf8").trimEnd().split("\n").slice(-80).join("\n")
    console.error(`\n[smoke] Last lines of ${install.log}:\n${log}`)
  } catch {
    console.error(`[smoke] The app wrote no log at ${install.log}.`)
  }
} finally {
  await stopApp()
  process.exit(exitCode)
}

/**
 * Polls a URL until it answers 200.
 * @param {string} url The URL.
 * @throws When it doesn't before the timeout, or the app exits first.
 */
async function waitFor(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (app?.exitCode !== null || app?.signalCode) throw new Error("The app exited before Blitz was ready.")
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`${url} did not answer within ${READY_TIMEOUT_MS / 60_000} minutes.`)
}

/**
 * Calls a public Convex function over the local backend's HTTP API.
 * @param {string} url The local Convex URL.
 * @param {"query" | "mutation"} kind The function kind.
 * @param {string} path The function, as `module:name`.
 * @param {Record<string, unknown>} args Its arguments.
 */
async function convex(url, kind, path, args) {
  const response = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  })
  const body = await response.json()
  if (body.status !== "success")
    throw new Error(`${path} failed: ${body.errorMessage ?? response.status}`)
  return body.value
}

/** Quits the app the way closing its window does, then makes sure it is gone. */
async function stopApp() {
  if (!app?.pid || app.exitCode !== null) return
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {}
    return
  }
  // SIGTERM lets the app stop its services; its own group catches stragglers.
  app.kill("SIGTERM")
  const deadline = Date.now() + 15_000
  while (app.exitCode === null && !app.signalCode && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    process.kill(-app.pid, "SIGKILL")
  } catch {}
}
