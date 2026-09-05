/** Starts the local web, database, and learning workers with a shared LAN address. */

import { spawn } from "node:child_process"
import { networkInterfaces } from "node:os"
import { isIP } from "node:net"

const port = process.env.BLITZ_PORT ?? "3001"
const lanAddress = process.env.BLITZ_LAN_ADDRESS?.trim() || findLanAddress()
const children = new Set()
let stopping = false

if (!lanAddress || isIP(lanAddress) !== 4) {
  console.error(
    "Blitz could not find a local network address. Connect to Wi-Fi and try again."
  )
  process.exit(1)
}

const sharedEnvironment = {
  ...process.env,
  BLITZ_LAN_ADDRESS: lanAddress,
  BLITZ_CONVEX_URL: process.env.BLITZ_CONVEX_URL ?? "http://127.0.0.1:3210",
  NEXT_PUBLIC_CONVEX_URL: `http://${lanAddress}:3210`,
  NEXT_PUBLIC_CONVEX_SITE_URL: `http://${lanAddress}:3211`,
}

console.log(`\nBlitz will be available on this Mac at http://localhost:${port}`)
console.log(
  `Open http://${lanAddress}:${port} on a phone connected to the same Wi-Fi.\n`
)

start("npx", ["convex", "dev", "--tail-logs", "disable"], process.env)
start(
  "npm",
  ["run", "dev", "--", "--hostname", "0.0.0.0", "--port", port],
  sharedEnvironment
)

start(
  process.execPath,
  ["--experimental-strip-types", "scripts/preparation-worker.ts"],
  sharedEnvironment
)
start(
  process.execPath,
  ["--experimental-strip-types", "scripts/chat-worker.ts"],
  sharedEnvironment
)
start(
  process.execPath,
  ["--experimental-strip-types", "scripts/research-worker.ts"],
  sharedEnvironment
)

process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

/** Returns the first external IPv4 address, or undefined when no LAN is available. */
function findLanAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address
    }
  }
}

/** Starts a child service and shuts down the full stack if that service exits. */
function start(command, args, environment) {
  // A process group keeps npm/npx grandchildren owned by this launcher on macOS.
  const child = spawn(command, args, {
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  })
  children.add(child)
  child.on("error", () => {
    console.error(`Could not start ${command}. Shutting Blitz down.`)
    stop("SIGTERM", 1)
  })
  child.on("exit", (code, signal) => {
    children.delete(child)
    if (!stopping) {
      console.error(
        `${command} stopped (${signal ?? code ?? "unknown"}). Shutting Blitz down.`
      )
      stop("SIGTERM", code ?? 1)
    }
  })
}

/** Stops only this launcher's service groups and lets their cleanup finish before exit. */
function stop(signal, exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      // An already-exited child needs no further shutdown work.
    }
  }
  process.exitCode = exitCode
}
