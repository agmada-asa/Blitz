/** Exposes the minimal, validated native desktop API to the renderer sandbox. */

const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("blitzDesktop", {
  /** Returns managed process state for the desktop status surface. */
  getServiceStatus: () => ipcRenderer.invoke("desktop:service-status"),
  /** Opens one existing file inside the selected project. */
  openFile: (projectId, path) =>
    ipcRenderer.invoke("desktop:open-file", { projectId, path }),
  /** Reveals one existing file inside the selected project in Finder. */
  revealFile: (projectId, path) =>
    ipcRenderer.invoke("desktop:reveal-file", { projectId, path }),
})
