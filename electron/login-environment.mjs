/** Recovers the user's shell environment for an app opened from Finder or the Dock. */

import { execFile } from "node:child_process"

/** Separates the variables from anything the shell's startup files print first. */
const START_MARKER = "__BLITZ_ENVIRONMENT__"

/** Shell bookkeeping that describes the probe shell rather than the user's setup. */
const SKIPPED_VARIABLES = new Set(["_", "OLDPWD", "PWD", "SHLVL"])

/**
 * Parses `env -0` output that follows the start marker.
 * @param {string} output The shell's complete standard output.
 * @returns {Record<string, string>} The variables, or nothing when the marker is missing.
 */
export function parseLoginEnvironment(output) {
  const start = output.indexOf(START_MARKER)
  if (start === -1) return {}
  const environment = {}
  for (const entry of output
    .slice(start + START_MARKER.length)
    .split("\0")) {
    const separator = entry.indexOf("=")
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    if (!SKIPPED_VARIABLES.has(name))
      environment[name] = entry.slice(separator + 1)
  }
  return environment
}

/**
 * Asks the user's login shell for its environment. macOS starts apps with a
 * minimal `PATH`, so without this a Finder launch cannot find a version manager's
 * `npm`, or the provider CLIs and Tailscale the server calls.
 * @param {{shell?: string, timeoutMs?: number}} [options] The shell and how long it may take.
 * @returns {Promise<Record<string, string>>} The variables to merge over `process.env`.
 * @throws When the shell cannot run or reports no environment.
 */
export function loadLoginEnvironment({
  shell = process.env.SHELL || "/bin/zsh",
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-ilc", `printf '%s' '${START_MARKER}'; env -0`],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not read your shell environment: ${error.message}`))
          return
        }
        const environment = parseLoginEnvironment(stdout)
        if (!environment.PATH) {
          reject(new Error(`${shell} did not report a PATH.`))
          return
        }
        resolve(environment)
      }
    )
  })
}
