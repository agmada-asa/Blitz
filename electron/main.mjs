/** Boots the Mac desktop shell, local Blitz services, and project-scoped native bridge. */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { lstat, mkdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { ServiceManager } from "./service-manager.mjs"
import {
  assertProjectPath,
  dataRoot,
  projectDirectory,
  projectSourcesDirectory,
  repositoryRoot,
} from "./paths.mjs"

const port = Number(process.env.BLITZ_PORT || 3001)
const host = process.env.BLITZ_LAN_ADDRESS ? "0.0.0.0" : "127.0.0.1"
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

/** Returns a conservative MIME type for a selected native source. */
function mimeTypeFor(filename) {
  return (
    {
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".txt": "text/plain",
      ".pdf": "application/pdf",
    }[extname(filename).toLowerCase()] || "application/octet-stream"
  )
}

/** Ensures a project directory exists before opening its native file chooser. */
async function ensureProjectDirectories(projectId) {
  const project = projectDirectory(projectId)
  for (const directory of [dataRoot(), dirname(project), project]) {
    try {
      const entry = await lstat(directory)
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error("Project data paths may not use symlinks.")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  await mkdir(projectSourcesDirectory(projectId), { recursive: true })
  return project
}

/** Registers the bounded, project-scoped native IPC handlers. */
function registerIpc() {
  ipcMain.handle("desktop:service-status", (event) => {
    assertTrustedSender(event)
    return services.snapshot()
  })
  ipcMain.handle("desktop:select-files", async (event, projectId) => {
    assertTrustedSender(event)
    await ensureProjectDirectories(projectId)
    const result = await dialog.showOpenDialog(mainWindow, {
      defaultPath: projectSourcesDirectory(projectId),
      properties: ["openFile", "multiSelections"],
    })
    if (result.canceled) return []
    const files = []
    for (const file of result.filePaths) {
      const metadata = await stat(file)
      if (!metadata.isFile()) throw new Error("Choose files, not folders.")
      if (metadata.size > 50_000_000)
        throw new Error("Source upload exceeds the size limit.")
      files.push({
        filename: basename(file),
        mimeType: mimeTypeFor(file),
        sizeBytes: metadata.size,
        contents: await readFile(file),
      })
    }
    return files
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
  app.on("second-instance", () => mainWindow?.show())
  registerIpc()
  await services.start()
  await createWindow()
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
