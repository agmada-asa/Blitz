/**
 * Keeps `npm run dev` readable. The launcher in `scripts/dev-lan.mjs` sends
 * Next, Convex, and worker output to a log file instead of the terminal; this
 * module follows that log and echoes only the lines that signal a problem,
 * once each per minute, prints the end of the log when startup fails, and opens the app in the
 * browser once it is ready.
 */

import { spawn } from "node:child_process"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"

/** Terminal colour and cursor sequences, removed before a line is inspected or echoed. */
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z]/g

/**
 * Words and symbols that Next, Convex, and the workers use for failures:
 * `⨯` is Next's error mark, `✖` is Convex's.
 */
const PROBLEM_PATTERN =
  /\b(error|errors|failed|failure|exception|unhandled|uncaught)\b|✖|⨯/i

/** A Next request log line that ended with a server error, such as ` GET /api/x 500 in 12ms`. */
const SERVER_ERROR_REQUEST = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+5\d\d\b/

/**
 * Removes terminal escape sequences and surrounding whitespace from one log line.
 * @param {string} line A raw line from a service.
 * @returns {string} The plain text.
 */
export function plainLine(line) {
  return line.replace(ANSI_SEQUENCE, "").trim()
}

/**
 * Decides whether a service log line is worth showing in a quiet terminal.
 * Warnings, request logs, and progress messages stay in the log file.
 * @param {string} line A raw line from a service, with or without colour.
 * @returns {boolean} True for errors, failures, and requests that answered 5xx.
 */
export function isProblemLine(line) {
  const text = plainLine(line)
  if (!text) return false
  return SERVER_ERROR_REQUEST.test(text) || PROBLEM_PATTERN.test(text)
}

/**
 * Creates the terminal's filter for service log lines. It passes problem lines
 * through without colour, and drops a line identical to one shown within
 * `repeatWindowMs`: a broken page fails on every health check, which would
 * otherwise print the same error twice a second.
 * @param {{repeatWindowMs?: number, now?: () => number}} [options] The repeat window and clock.
 * @returns {(line: string) => string | undefined} The text to show, or undefined to keep it in the log only.
 */
export function createProblemFilter({ repeatWindowMs = 60_000, now = Date.now } = {}) {
  /** @type {Map<string, number>} When each recently shown line was last shown. */
  const shownAt = new Map()
  return (line) => {
    if (!isProblemLine(line)) return undefined
    const text = plainLine(line)
    const time = now()
    const previous = shownAt.get(text)
    if (previous !== undefined && time - previous < repeatWindowMs) return undefined
    // Forget expired lines so a long session does not grow the map without bound.
    for (const [shown, at] of shownAt) if (time - at >= repeatWindowMs) shownAt.delete(shown)
    shownAt.set(text, time)
    return text
  }
}

/**
 * Follows a growing log file from `offset` and passes each complete new line
 * to `onLine`. A file that shrinks (rotated or truncated) is read again from
 * its start.
 * @param {string} path The log file.
 * @param {number} offset The byte position to start reading from.
 * @param {(line: string) => void} onLine Called once per complete line.
 * @param {{intervalMs?: number}} [options] How often the file is checked.
 * @returns {() => void} Stops following; the last partial line is dropped.
 */
export function followLog(path, offset, onLine, { intervalMs = 500 } = {}) {
  let position = offset
  let pending = ""
  const timer = setInterval(() => {
    let size
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < position) {
      position = 0
      pending = ""
    }
    if (size === position) return
    const text = readRange(path, position, size)
    position = size
    const lines = (pending + text).split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Returns the last lines written to a log since `offset`, without colour.
 * @param {string} path The log file.
 * @param {number} offset Where this run's output starts.
 * @param {number} [count] How many lines to keep.
 * @returns {string[]} The lines, oldest first; empty when the log cannot be read.
 */
export function tailLog(path, offset, count = 30) {
  try {
    const size = statSync(path).size
    const start = size >= offset ? offset : 0
    return readRange(path, start, size)
      .split("\n")
      .map(plainLine)
      .filter(Boolean)
      .slice(-count)
  } catch {
    return []
  }
}

/**
 * Reads bytes `[start, end)` of a file as UTF-8. A multi-byte character split
 * across two reads shows as a replacement character, which is acceptable for
 * log display.
 * @param {string} path The file.
 * @param {number} start First byte.
 * @param {number} end Byte after the last one.
 * @returns {string} The decoded text.
 */
function readRange(path, start, end) {
  const buffer = Buffer.alloc(end - start)
  const fd = openSync(path, "r")
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  return buffer.toString("utf8")
}

/**
 * Shortens a path under the home folder to `~/…` for display.
 * @param {string} path An absolute path.
 * @returns {string} The display form.
 */
export function displayPath(path) {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Opens a URL in the default browser without waiting for it. Failures are
 * ignored: the URL is already printed in the terminal.
 * @param {string} url The page to open.
 */
export function openInBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.once("error", () => undefined)
    child.unref()
  } catch {}
}
