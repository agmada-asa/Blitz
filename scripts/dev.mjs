/** Starts the Next.js development server and guarantees bounded process-group cleanup. */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  killProcessGroups,
  processGroupExists,
  terminateProcessGroups,
} from "./process-groups.mjs"

const nextCli = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url)
)
const child = spawn(
  process.execPath,
  [nextCli, "dev", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    detached: process.platform !== "win32",
  }
)
const processGroups = new Set(
  process.platform !== "win32" && child.pid ? [child.pid] : []
)
let stopping = false

process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

child.once("error", () => {
  console.error("Could not start the Next.js development server.")
  stop("SIGTERM", 1)
})

child.once("exit", (code, signal) => {
  if (
    process.platform !== "win32" &&
    child.pid &&
    !processGroupExists(child.pid)
  )
    processGroups.delete(child.pid)
  if (!stopping) stop("SIGTERM", code ?? (signal ? 1 : 0))
})

/** Stops Next and any surviving descendants, with a second interrupt forcing exit. */
function stop(signal, exitCode = 0) {
  if (stopping) {
    if (process.platform !== "win32") killProcessGroups(processGroups)
    else child.kill("SIGKILL")
    process.exit(exitCode)
  }
  stopping = true
  if (process.platform === "win32") {
    child.kill(signal)
    process.exitCode = exitCode
    return
  }
  void terminateProcessGroups(processGroups, { signal })
    .catch(() => {
      killProcessGroups(processGroups)
    })
    .finally(() => process.exit(exitCode))
}
