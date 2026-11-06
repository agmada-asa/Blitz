/**
 * Boots the Mac desktop shell, local Blitz services, and project-scoped native bridge.
 *
 * The window prefers a Blitz that is already serving: the background server
 * (`npm run server -- install`), which it starts if it is installed but not
 * running, or `npm run dev:lan`. Only when neither exists does the app host
 * the stack itself, in production mode: from the current release with the
 * updater when the app runs from `~/.blitz`, or from a production build of
 * its checkout otherwise. The Blitz menu checks for updates or rebuilds.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  shell,
} from "electron"
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  AutoUpdater,
  readServerState,
  requestUpdate,
  shortCommit,
  waitForCheck,
} from "./auto-update.mjs"
import { isServerInstalled, startServer } from "./background-server.mjs"
import { loadLoginEnvironment } from "./login-environment.mjs"
import {
  blitzHome,
  buildCheckout,
  CHECKOUT_DIST_DIR,
  homePaths,
  readRelease,
  readServerConfig,
  ReleaseManager,
} from "./release-manager.mjs"
import { startStudyReminders } from "./reminders.mjs"
import { findRunningStack, ServiceManager } from "./service-manager.mjs"
import { assertProjectPath, repositoryRoot } from "./paths.mjs"

const desktopPort = Number(process.env.BLITZ_PORT || 3008)
/** Where the background server and `npm run dev:lan` serve Blitz, which the desktop app can share. */
const lanPort = 3007
const host = process.env.BLITZ_LAN_ADDRESS ? "0.0.0.0" : "127.0.0.1"
/** How long to wait for the background server, which may be building its first release. */
const serverStartTimeoutMs = 3 * 60_000
/** Shared native icon used by the macOS Dock and non-macOS window chrome. */
const appIconPath = join(repositoryRoot(), "app", "apple-icon.png")
const logPath = app.isPackaged ? join(app.getPath("logs"), "blitz.log") : undefined
const isOnlyInstance = app.requestSingleInstanceLock()
const launchedAt = new Date().toISOString()
/** @type {ServiceManager | undefined} Set only when this app hosts the stack. */
let services
/** @type {AutoUpdater | undefined} Set only when this app hosts a release. */
let updater
/** The port the window loads, which differs when sharing a running stack. */
let port = desktopPort
let mainWindow
let shutdownStarted
let shutdownFinished = false
let updateRunning = false

/**
 * Returns a plain page that says what Blitz is doing while services start.
 * @param {string} message One short sentence.
 */
function statusPage(message) {
  const text = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><title>Blitz</title><style>html{color-scheme:dark;height:100%}body{height:100%;margin:0;display:grid;place-items:center;background:#111;color:#999;font:14px -apple-system,sans-serif}</style><p>${text}</p>`
  )}`
}

/**
 * A packaged app has no terminal, so its services write to a log that starts
 * fresh each launch and keeps the previous one beside it.
 */
function serviceOutput() {
  if (!logPath) return "inherit"
  mkdirSync(app.getPath("logs"), { recursive: true })
  if (existsSync(logPath)) renameSync(logPath, `${logPath}.previous`)
  const log = openSync(logPath, "a")
  return ["ignore", log, log]
}

/** Opens the isolated BrowserWindow straight away, showing that Blitz is starting. */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    icon: appIconPath,
    backgroundColor: "#111111",
    webPreferences: {
      preload: join(repositoryRoot(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.on("closed", () => {
    mainWindow = undefined
    app.quit()
  })
  await mainWindow.loadURL(statusPage("Starting Blitz…"))
}

/** Rejects renderer calls that do not originate from the loopback Next app. */
function assertTrustedSender(event) {
  const frame = event.senderFrame
  const url = frame?.url ? new URL(frame.url) : undefined
  const topUrl = frame?.top?.url ? new URL(frame.top.url) : undefined
  if (
    !url ||
    !topUrl ||
    url.origin !== `http://127.0.0.1:${port}` ||
    topUrl.origin !== `http://127.0.0.1:${port}`
  )
    throw new Error("Untrusted desktop renderer.")
}

/** Registers the bounded, project-scoped native IPC handlers. */
function registerIpc() {
  ipcMain.handle("desktop:service-status", (event) => {
    assertTrustedSender(event)
    return services?.snapshot() ?? {}
  })
  ipcMain.handle("desktop:open-file", async (event, { projectId, path }) => {
    assertTrustedSender(event)
    const file = await assertProjectPath(projectId, path)
    return shell.openPath(file)
  })
  ipcMain.handle("desktop:reveal-file", async (event, { projectId, path }) => {
    assertTrustedSender(event)
    const file = await assertProjectPath(projectId, path)
    shell.showItemInFolder(file)
    return file
  })
}

/** Installs the app menu with the update actions beside the standard macOS items. */
function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Check for updates…", click: () => void runUpdate("check") },
          { label: "Rebuild Blitz now", click: () => void runUpdate("rebuild") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ])
  )
}

/**
 * Checks for updates or rebuilds, through this app's own updater or the
 * background server's, and reports the outcome in a dialog.
 * @param {"check" | "rebuild"} action What the learner chose.
 */
async function runUpdate(action) {
  if (updateRunning) return
  updateRunning = true
  try {
    new Notification({
      title: action === "rebuild" ? "Rebuilding Blitz" : "Checking for updates",
      body:
        action === "rebuild"
          ? "This takes about a minute. Blitz keeps working until the new build is ready."
          : "Blitz keeps working while it checks.",
    }).show()
    const result = updater
      ? await updater.check({ rebuild: action === "rebuild", reason: "manual" })
      : await waitForCheck(blitzHome(), await requestUpdate(blitzHome(), action))
    if (result.status === "failed") lastFailureAt = result.at
    await showUpdateResult(result)
  } catch (error) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Couldn't check for updates",
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    updateRunning = false
  }
}

/**
 * Shows one update outcome, offering to reload after an update or to open the build log after a failure.
 * @param {import("./auto-update.mjs").CheckResult} result The finished check.
 */
async function showUpdateResult(result) {
  if (result.status === "updated") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Blitz updated",
      detail: result.message,
      buttons: ["Reload now", "Later"],
    })
    if (response === 0) mainWindow?.reload()
    return
  }
  if (result.status === "failed") {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "Blitz couldn't update",
      detail: `${result.message}\n\nThe current version keeps running.`,
      buttons: result.logPath ? ["Show build log", "OK"] : ["OK"],
    })
    if (response === 0 && result.logPath) shell.showItemInFolder(result.logPath)
    return
  }
  await dialog.showMessageBox({
    type: result.status === "offline" ? "warning" : "info",
    message:
      result.status === "up-to-date"
        ? "Blitz is up to date"
        : result.status === "offline"
          ? "Couldn't check for updates"
          : "No update to install",
    detail: result.message,
  })
}

/** The last update failure already shown, so each one is announced once. */
let lastFailureAt = launchedAt
/** The release the window last loaded, to announce background updates. */
let shownRelease

/**
 * Announces background updates and failed builds every minute: an update
 * offers a reload, and a failure links to its build log.
 */
function watchServerState() {
  const timer = setInterval(async () => {
    const state = await readServerState(blitzHome())
    if (!state) return
    const failure = state.failure
    if (failure?.at && failure.at > lastFailureAt) {
      lastFailureAt = failure.at
      const notification = new Notification({
        title: "Blitz couldn't update",
        body: "The current version keeps running. Click to see the build log.",
      })
      notification.on("click", () => {
        if (failure.logPath) shell.showItemInFolder(failure.logPath)
      })
      notification.show()
    }
    const release = state.release?.commit
    if (release && shownRelease && release !== shownRelease) {
      const notification = new Notification({
        title: "Blitz updated",
        body: `Now running ${shortCommit(release)}. Click to reload.`,
      })
      notification.on("click", () => mainWindow?.reload())
      notification.show()
    }
    if (release) shownRelease = release
  }, 60_000)
  timer.unref?.()
}

/**
 * Waits for a running Blitz stack, such as the background server starting.
 * @param {number} timeoutMs How long to wait.
 */
async function waitForStack(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const running = await findRunningStack(repositoryRoot(), [lanPort, desktopPort])
    if (running) return running
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return undefined
}

/**
 * Starts the stack inside this app: the current release with the updater, or
 * a production build of this checkout.
 */
async function hostStack() {
  const home = blitzHome()
  const config = await readServerConfig(home)
  const release = await readRelease(repositoryRoot())
  services = new ServiceManager({
    cwd: repositoryRoot(),
    port: desktopPort,
    host,
    production: true,
    distDir: release ? undefined : CHECKOUT_DIST_DIR,
    pidFile: join(homePaths(home).run, "desktop-services.json"),
    stdio: serviceOutput(),
  })
  await services.reapOrphans()
  if (release && config) {
    updater = new AutoUpdater({
      releases: new ReleaseManager({ home, config }),
      services,
      home,
      host: "desktop",
    })
    await mainWindow?.loadURL(statusPage("Preparing Blitz…"))
    await updater.prepare()
  } else {
    const environment = await services.prepareEnvironment()
    await mainWindow?.loadURL(statusPage("Building Blitz. This takes about a minute the first time…"))
    await buildCheckout(repositoryRoot(), {
      NEXT_PUBLIC_CONVEX_URL: environment.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_SITE_URL: environment.NEXT_PUBLIC_CONVEX_SITE_URL,
    })
  }
  await mainWindow?.loadURL(statusPage("Starting Blitz…"))
  await services.start()
  updater?.listenForRequests()
  updater?.start()
}

/** Ensures a single desktop host, finds or starts local services, and opens the app. */
async function boot() {
  if (
    process.platform !== "darwin" &&
    process.env.BLITZ_ALLOW_NON_MAC !== "1"
  ) {
    dialog.showErrorBox(
      "Blitz desktop",
      "The local desktop host currently supports macOS only."
    )
    app.quit()
    return
  }
  if (!isOnlyInstance) {
    app.quit()
    return
  }
  // The packaged app already has its macOS icon; this would replace it with the square one.
  if (process.platform === "darwin" && !app.isPackaged)
    app.dock?.setIcon(appIconPath)
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })
  registerIpc()
  installMenu()
  await createWindow()
  if (app.isPackaged) Object.assign(process.env, await loadLoginEnvironment())
  let running = await findRunningStack(repositoryRoot(), [lanPort, desktopPort])
  if (!running && isServerInstalled()) {
    await startServer().catch(() => undefined)
    running = await waitForStack(serverStartTimeoutMs)
  }
  if (running) port = running.port
  else await hostStack()
  // The learner may have closed the window while the services were starting.
  if (!mainWindow) return
  shownRelease = (await readServerState(blitzHome()))?.release?.commit
  watchServerState()
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
  startReminders(running?.convexUrl ?? services.environment.BLITZ_CONVEX_URL)
}

/**
 * Starts the daily study reminder. Clicking the notification opens the unit
 * the learner is working through, or Home.
 */
function startReminders(convexUrl) {
  if (!Notification.isSupported()) return
  const convex = new ConvexHttpClient(convexUrl)
  // The last reminder day survives restarts so reopening Blitz in the evening
  // does not send the same day's reminder again.
  const statePath = join(app.getPath("userData"), "study-reminder.json")
  let lastRemindedDay
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8"))
    if (typeof saved?.lastRemindedDay === "string")
      lastRemindedDay = saved.lastRemindedDay
  } catch {
    // No reminder has been sent yet, or the file is unreadable; start fresh.
  }
  startStudyReminders({
    lastRemindedDay,
    onReminded: (day) => {
      try {
        writeFileSync(statePath, JSON.stringify({ lastRemindedDay: day }))
      } catch {
        // A missed write only risks one repeated reminder after a restart.
      }
    },
    loadSummary: (now) =>
      convex.query(anyApi.progress.today, {
        tzOffsetMinutes: now.getTimezoneOffset(),
        now: now.getTime(),
      }),
    notify: ({ title, body, path }) => {
      const notification = new Notification({ title, body })
      notification.on("click", () => {
        if (!mainWindow) return
        void mainWindow.loadURL(`http://127.0.0.1:${port}${path}`)
        mainWindow.show()
        mainWindow.focus()
      })
      notification.show()
    },
  })
}

/** Stops the hosted stack, if any, before the Electron process exits. */
function shutdown() {
  updater?.stop()
  shutdownStarted ??= (services?.stop() ?? Promise.resolve()).finally(() => {
    shutdownFinished = true
  })
  return shutdownStarted
}

app
  .whenReady()
  .then(boot)
  .catch(async (error) => {
    await shutdown()
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(
      "Blitz could not start",
      logPath ? `${message}\n\nDetails are in ${logPath}` : message
    )
    app.quit()
  })
// Closing the window asks to quit twice. Every request has to wait for the
// shutdown, or the exit hook kills the launchers before they can stop Next.
app.on("before-quit", (event) => {
  if (shutdownFinished) return
  event.preventDefault()
  shutdown().finally(() => app.quit())
})
app.on("window-all-closed", () => app.quit())
// Detached service groups must not outlive a crashed desktop host.
process.once("exit", () => services?.killNow())
