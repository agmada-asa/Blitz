/** Boots the Mac desktop shell, local Blitz services, and project-scoped native bridge. */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron"
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startStudyReminders } from "./reminders.mjs"
import { ServiceManager } from "./service-manager.mjs"
import { assertProjectPath, repositoryRoot } from "./paths.mjs"

const port = Number(process.env.BLITZ_PORT || 3008)
const host = process.env.BLITZ_LAN_ADDRESS ? "0.0.0.0" : "127.0.0.1"
/** Shared native icon used by the macOS Dock and non-macOS window chrome. */
const appIconPath = join(repositoryRoot(), "app", "apple-icon.png")
const services = new ServiceManager({ cwd: repositoryRoot(), port, host })
let mainWindow
let shuttingDown = false

/** Creates the isolated BrowserWindow and loads the existing Next interface. */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    icon: appIconPath,
    webPreferences: {
      preload: join(repositoryRoot(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
  mainWindow.on("closed", () => {
    mainWindow = undefined
    if (!shuttingDown) app.quit()
  })
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
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath)
  app.on("second-instance", () => mainWindow?.show())
  registerIpc()
  await services.start()
  await createWindow()
  startReminders()
}

/**
 * Starts the daily study reminder. Clicking the notification opens the unit
 * the learner is working through, or Home.
 */
function startReminders() {
  if (!Notification.isSupported()) return
  const convex = new ConvexHttpClient(services.environment.BLITZ_CONVEX_URL)
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
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await services.stop()
}

app
  .whenReady()
  .then(boot)
  .catch(async (error) => {
    await shutdown()
    dialog.showErrorBox(
      "Blitz could not start",
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })
app.on("before-quit", (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shutdown().finally(() => app.quit())
})
app.on("window-all-closed", () => app.quit())
// Detached service groups must not outlive a crashed desktop host.
process.once("exit", () => services.killNow())
