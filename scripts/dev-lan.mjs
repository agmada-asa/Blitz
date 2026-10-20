/**
 * Starts the local web app, database, and background worker for this Mac and the LAN.
 *
 * Uses the same supervisor as the desktop app, so a crashed worker or server
 * restarts with backoff instead of taking the whole stack down. Without a
 * network connection Blitz still runs on this Mac; phone access needs Wi-Fi.
 */

import { networkInterfaces } from "node:os"
import { isIP } from "node:net"
import { fileURLToPath } from "node:url"
import { formatTerminalQr } from "./lan-qr.mjs"
import { ServiceManager } from "../electron/service-manager.mjs"

const port = Number(process.env.BLITZ_PORT ?? "3007")
const configuredLanAddress = process.env.BLITZ_LAN_ADDRESS?.trim()
const lanAddress =
  configuredLanAddress && isIP(configuredLanAddress) === 4
    ? configuredLanAddress
    : findLanAddress()

const services = new ServiceManager({
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  port,
  host: "0.0.0.0",
  desktop: false,
  environment: {
    ...process.env,
    ...(lanAddress ? { BLITZ_LAN_ADDRESS: lanAddress } : {}),
  },
  onStatus: reportStatus,
})

let stopping = false
process.on("SIGINT", () => void stop(0))
process.on("SIGTERM", () => void stop(0))
process.on("SIGHUP", () => void stop(129))
process.once("exit", () => services.killNow())

console.log(`\nBlitz will be available on this Mac at http://localhost:${port}`)
if (lanAddress) {
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
} else {
  console.log(
    "No Wi-Fi address found, so phones cannot connect. Blitz still runs on this Mac.\n"
  )
}

try {
  await services.start()
  console.log(`\nBlitz is ready at http://localhost:${port}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  await stop(1)
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
  await services.stop()
  process.exit(exitCode)
}
