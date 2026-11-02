/** Boots the Mac desktop shell, local Blitz services, and project-scoped native bridge. */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron"
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
import { loadLoginEnvironment } from "./login-environment.mjs"
import { startStudyReminders } from "./reminders.mjs"
import { findRunningStack, ServiceManager } from "./service-manager.mjs"
import { assertProjectPath, repositoryRoot } from "./paths.mjs"

const desktopPort = Number(process.env.BLITZ_PORT || 3008)
/** Where `npm run dev:lan` serves Blitz, which the desktop app can share. */
const lanPort = 3007
const host = process.env.BLITZ_LAN_ADDRESS ? "0.0.0.0" : "127.0.0.1"
/** Shared native icon used by the macOS Dock and non-macOS window chrome. */
const appIconPath = join(repositoryRoot(), "app", "apple-icon.png")
/** Shown from launch until the local services answer. */
const startingPage = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><title>Blitz</title><style>html{color-scheme:dark;height:100%}body{height:100%;margin:0;display:grid;place-items:center;background:#111;color:#999;font:14px -apple-system,sans-serif}</style><p>Starting Blitz…</p>`
)}`
const logPath = app.isPackaged ? join(app.getPath("logs"), "blitz.log") : undefined
const isOnlyInstance = app.requestSingleInstanceLock()
const services = new ServiceManager({
  cwd: repositoryRoot(),
  port: desktopPort,
  host,
  // A second launch only hands over to the first, so it must not rotate its log.
  stdio: isOnlyInstance ? serviceOutput() : "ignore",
})
/** The port the window loads, which differs when sharing a running stack. */
let port = desktopPort
let mainWindow
let shutdownStarted
let shutdownFinished = false

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
  await mainWindow.loadURL(startingPage)
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
    return services.snapshot()
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

/** Ensures a single desktop host, starts local services, and opens the app. */
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
  await createWindow()
  if (app.isPackaged) Object.assign(process.env, await loadLoginEnvironment())
  const running = await findRunningStack(repositoryRoot(), [
    lanPort,
    desktopPort,
  ])
  if (running) port = running.port
  else await services.start()
  // The learner may have closed the window while the services were starting.
  if (!mainWindow) return
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

/** Stops every managed process group before the Electron process exits. */
function shutdown() {
  shutdownStarted ??= services.stop().finally(() => {
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
process.once("exit", () => services.killNow())
