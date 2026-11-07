/**
 * Installs and controls the Blitz background server, a per-user launchd agent.
 *
 * The agent runs `scripts/dev-lan.mjs --service` from `~/.blitz/current`, so
 * Blitz serves the phone and the desktop app from the newest release without a
 * terminal, restarts after a crash, and starts again at login. The desktop app
 * and `npm run dev:lan` only attach to it. macOS only.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { homePaths } from "./release-manager.mjs"

/** The launchd label, also used as the plist's file name. */
export const LAUNCH_AGENT_LABEL = "dev.blitz.server"

/** Exit code that asks launchd to start the server again with new runner code. */
export const RESTART_EXIT_CODE = 75

/** Returns the agent's plist path in the user's LaunchAgents folder. */
export function launchAgentPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`)
}

/** Reports whether the background server is installed on this Mac. */
export function isServerInstalled() {
  return process.platform === "darwin" && existsSync(launchAgentPath())
}

/** Returns the launchd target that names the agent in the user's session. */
function serviceTarget() {
  return `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT_LABEL}`
}

/**
 * Runs `launchctl` and resolves with its output.
 * @param {string[]} args Arguments after `launchctl`.
 * @throws With launchctl's message when it fails.
 */
function launchctl(args) {
  return new Promise((resolve, reject) => {
    execFile("launchctl", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()))
      else resolve(stdout)
    })
  })
}

/**
 * Escapes text for a plist string.
 * @param {string} value Any text.
 */
function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * Writes the agent's plist and loads it, replacing an earlier copy.
 * @param {{home: string, nodePath: string, environment: Record<string, string>}} options
 *   `nodePath` is an absolute Node binary, since launchd has no shell `PATH`;
 *   `environment` holds the variables the server needs before it reads the
 *   login shell's own environment.
 */
export async function installLaunchAgent({ home, nodePath, environment }) {
  const paths = homePaths(home)
  await mkdir(paths.logs, { recursive: true })
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
  const variables = Object.entries(environment)
    .map(
      ([name, value]) =>
        `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`
    )
    .join("\n")
  const log = join(paths.logs, "server.log")
  await writeFile(
    launchAgentPath(),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(nodePath)}</string>
      <string>${xml(join(paths.current, "scripts", "dev-lan.mjs"))}</string>
      <string>--service</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(home)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${variables}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
  </dict>
</plist>
`
  )
  await stopServer()
  await launchctl(["bootstrap", `gui/${process.getuid?.() ?? 0}`, launchAgentPath()])
}

/** Stops the server and unloads it until the next login or `startServer`. */
export async function stopServer() {
  try {
    await launchctl(["bootout", serviceTarget()])
  } catch {
    // Not loaded.
  }
}

/** Loads the installed server if it is not loaded, or starts it if it is. */
export async function startServer() {
  try {
    await launchctl(["kickstart", serviceTarget()])
  } catch {
    await launchctl(["bootstrap", `gui/${process.getuid?.() ?? 0}`, launchAgentPath()])
  }
}

/** Stops the server and removes its plist; releases and logs stay in the Blitz home. */
export async function uninstallLaunchAgent() {
  await stopServer()
  await rm(launchAgentPath(), { force: true })
}

/**
 * Reports whether launchd has the server loaded and running.
 * @returns {Promise<{loaded: boolean, pid?: number}>}
 */
export async function serverProcess() {
  try {
    const output = await launchctl(["print", serviceTarget()])
    const pid = Number(output.match(/^\s*pid = (\d+)/m)?.[1])
    return { loaded: true, ...(pid ? { pid } : {}) }
  } catch {
    return { loaded: false }
  }
}
