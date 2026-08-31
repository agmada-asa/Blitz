import { spawn } from "node:child_process"
import { networkInterfaces } from "node:os"

const port = process.env.BLITZ_PORT ?? "3001"
const lanAddress = findLanAddress()
const children = new Set()
let stopping = false

if (!lanAddress) {
  console.error(
    "Blitz could not find a local network address. Connect to Wi-Fi and try again."
  )
  process.exit(1)
}

const sharedEnvironment = {
  ...process.env,
  BLITZ_LAN_ADDRESS: lanAddress,
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

process.on("SIGINT", () => stop("SIGINT"))
process.on("SIGTERM", () => stop("SIGTERM"))

function findLanAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address
    }
  }
}

function start(command, args, environment) {
  const child = spawn(command, args, { env: environment, stdio: "inherit" })
  children.add(child)
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

function stop(signal, exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill(signal)
  setTimeout(() => process.exit(exitCode), 500).unref()
}
