/**
 * Installs and controls the Blitz background server, a per-user service: a
 * launchd agent on macOS and a systemd user unit on Linux.
 *
 * The service runs `scripts/dev-lan.mjs --service` from `~/.blitz/current`, so
 * Blitz serves the phone and the desktop app from the newest release without a
 * terminal, restarts after a crash, and starts again at login. The desktop app
 * and `npm run dev:lan` only attach to it. Other platforms have no background
 * server.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { homePaths } from "./release-manager.mjs"

/** The service's name: the launchd label, and the systemd unit's name before `.service`. */
export const LAUNCH_AGENT_LABEL = "dev.blitz.server"

/** Exit code that asks the service manager to start the server again with new runner code. */
export const RESTART_EXIT_CODE = 75

/** The systemd unit's full name. */
const SYSTEMD_UNIT = `${LAUNCH_AGENT_LABEL}.service`

/**
 * @typedef {{home: string, nodePath: string, environment: Record<string, string>}} ServiceOptions
 *   `nodePath` is an absolute Node binary, since the service manager has no
 *   shell `PATH`; `environment` holds the variables the server needs before it
 *   reads the login shell's own environment.
 */

/** Reports whether this platform has a background server. */
export function supportsBackgroundServer() {
  return process.platform === "darwin" || process.platform === "linux"
}

/**
 * Returns the service's definition file: the plist in the user's LaunchAgents
 * folder on macOS, or the unit in the user's systemd folder on Linux.
 */
export function serviceFilePath() {
  if (process.platform === "linux") {
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    return join(config, "systemd", "user", SYSTEMD_UNIT)
  }
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`)
}

/** Reports whether the background server is installed on this computer. */
export function isServerInstalled() {
  return supportsBackgroundServer() && existsSync(serviceFilePath())
}

/**
 * Runs a service manager command and resolves with its output.
 * @param {string} command `launchctl` or `systemctl`.
 * @param {string[]} args Its arguments.
 * @throws With the command's message when it fails or is missing.
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()))
      else resolve(stdout)
    })
  })
}

/** The launchd domain for the user's login session. */
function launchdDomain() {
  return `gui/${process.getuid?.() ?? 0}`
}

/** The launchd target that names the agent in the user's session. */
function launchdTarget() {
  return `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`
}

/**
 * Runs `systemctl --user` and resolves with its output.
 * @param {string[]} args Arguments after `--user`.
 */
function systemctl(args) {
  return run("systemctl", ["--user", ...args])
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
 * Quotes one value for a systemd unit setting. Backslashes and quotes are
 * escaped, and `%` is doubled so systemd does not read it as a specifier.
 * @param {string} value Any single-line text.
 * @throws When the value spans lines, which a unit setting cannot hold.
 */
function systemdQuote(value) {
  if (/[\r\n]/.test(value)) throw new Error("A service setting cannot span lines.")
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`
}

/**
 * Builds the launchd plist that runs the server.
 * @param {ServiceOptions} options
 * @returns {string} The plist's text.
 */
export function launchAgentPlist({ home, nodePath, environment }) {
  const paths = homePaths(home)
  const variables = Object.entries(environment)
    .map(
      ([name, value]) =>
        `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`
    )
    .join("\n")
  const log = join(paths.logs, "server.log")
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

/**
 * Builds the systemd user unit that runs the server, with the same behaviour
 * as the launchd agent: started at login, restarted 10 seconds after any exit
 * (including `RESTART_EXIT_CODE`) without ever giving up, and logging to
 * `server.log`. On stop only the launcher gets `SIGTERM`, since it stops its
 * own process groups; anything left after 30 seconds is killed.
 * @param {ServiceOptions} options
 * @returns {string} The unit's text.
 */
export function systemdUnit({ home, nodePath, environment }) {
  const paths = homePaths(home)
  const log = join(paths.logs, "server.log").replaceAll("%", "%%")
  const command = [nodePath, join(paths.current, "scripts", "dev-lan.mjs"), "--service"]
    .map(systemdQuote)
    .join(" ")
    // `$` would otherwise expand environment variables in the command line.
    .replaceAll("$", "$$$$")
  const variables = Object.entries(environment)
    .map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`)
    .join("\n")
  return `[Unit]
Description=Blitz background server
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=${command}
WorkingDirectory=${home.replaceAll("%", "%%")}
${variables}
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`
}

/**
 * Writes the service's definition and starts it, replacing an earlier copy.
 * @param {ServiceOptions} options
 * @throws On Linux without a systemd user session, with how to proceed.
 */
export async function installService(options) {
  await mkdir(homePaths(options.home).logs, { recursive: true })
  await mkdir(dirname(serviceFilePath()), { recursive: true })
  if (process.platform === "linux") {
    try {
      await systemctl(["show-environment"])
    } catch {
      throw new Error(
        "The background server needs systemd's user service manager (systemctl --user), which is not running here. Use npm run dev:lan instead."
      )
    }
    await writeFile(serviceFilePath(), systemdUnit(options))
    await systemctl(["daemon-reload"])
    await systemctl(["enable", SYSTEMD_UNIT])
    await systemctl(["restart", SYSTEMD_UNIT])
    return
  }
  await writeFile(serviceFilePath(), launchAgentPlist(options))
  await stopServer()
  await run("launchctl", ["bootstrap", launchdDomain(), serviceFilePath()])
}

/** Stops the server until the next login or `startServer`. */
export async function stopServer() {
  try {
    if (process.platform === "linux") await systemctl(["stop", SYSTEMD_UNIT])
    else await run("launchctl", ["bootout", launchdTarget()])
  } catch {
    // Not loaded.
  }
}

/** Starts the installed server, loading it first when launchd has not. */
export async function startServer() {
  if (process.platform === "linux") {
    await systemctl(["start", SYSTEMD_UNIT])
    return
  }
  try {
    await run("launchctl", ["kickstart", launchdTarget()])
  } catch {
    await run("launchctl", ["bootstrap", launchdDomain(), serviceFilePath()])
  }
}

/** Stops the server and removes its definition; releases and logs stay in the Blitz home. */
export async function uninstallService() {
  if (process.platform === "linux") {
    await systemctl(["disable", "--now", SYSTEMD_UNIT]).catch(() => {})
    await rm(serviceFilePath(), { force: true })
    await systemctl(["daemon-reload"]).catch(() => {})
    return
  }
  await stopServer()
  await rm(serviceFilePath(), { force: true })
}

/**
 * Reads `systemctl show` output into a map of property names to values.
 * @param {string} output Lines of `Name=value`.
 * @returns {Record<string, string>}
 */
export function parseSystemdProperties(output) {
  /** @type {Record<string, string>} */
  const properties = {}
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=")
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1).trim()
  }
  return properties
}

/**
 * Reports whether the service manager has the server loaded and running.
 * `loaded` without a `pid` means it is waiting to start it again.
 * @returns {Promise<{loaded: boolean, pid?: number}>}
 */
export async function serverProcess() {
  try {
    if (process.platform === "linux") {
      const { ActiveState, MainPID } = parseSystemdProperties(
        await systemctl(["show", SYSTEMD_UNIT, "--property=ActiveState,MainPID"])
      )
      const pid = Number(MainPID)
      // `activating` covers the wait between automatic restarts.
      const loaded = ActiveState === "active" || ActiveState === "activating" || ActiveState === "reloading"
      return { loaded, ...(loaded && pid ? { pid } : {}) }
    }
    const output = await run("launchctl", ["print", launchdTarget()])
    const pid = Number(output.match(/^\s*pid = (\d+)/m)?.[1])
    return { loaded: true, ...(pid ? { pid } : {}) }
  } catch {
    return { loaded: false }
  }
}
