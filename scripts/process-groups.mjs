/** Owns bounded, testable shutdown for child process groups started by local launchers. */

import { setTimeout as pause } from "node:timers/promises"

/** Returns positive integer process-group IDs and drops missing or invalid child PIDs. */
function validGroupIds(groupIds) {
  return [...new Set(groupIds)].filter(
    (groupId) => Number.isInteger(groupId) && groupId > 0
  )
}

/** Sends a signal to a process group and ignores groups that have already exited. */
export function signalProcessGroup(
  groupId,
  signal,
  killProcess = process.kill
) {
  try {
    killProcess(-groupId, signal)
    return true
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH")
      return false
    throw error
  }
}

/** Checks whether any process still belongs to a process group. */
export function processGroupExists(groupId, killProcess = process.kill) {
  try {
    killProcess(-groupId, 0)
    return true
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH")
      return false
    if (error && typeof error === "object" && error.code === "EPERM")
      return true
    throw error
  }
}

/**
 * Stops owned process groups, waits briefly for cleanup, then kills any survivors.
 * Returns true when forced cleanup was needed.
 */
export async function terminateProcessGroups(
  groupIds,
  {
    signal = "SIGTERM",
    graceMs = 3_000,
    pollMs = 50,
    killProcess = process.kill,
    wait = pause,
  } = {}
) {
  const groups = validGroupIds(groupIds)
  for (const groupId of groups) signalProcessGroup(groupId, signal, killProcess)

  const deadline = Date.now() + Math.max(0, graceMs)
  let survivors = groups.filter((groupId) =>
    processGroupExists(groupId, killProcess)
  )
  while (survivors.length > 0 && Date.now() < deadline) {
    await wait(Math.min(Math.max(1, pollMs), deadline - Date.now()))
    survivors = survivors.filter((groupId) =>
      processGroupExists(groupId, killProcess)
    )
  }

  for (const groupId of survivors)
    signalProcessGroup(groupId, "SIGKILL", killProcess)
  return survivors.length > 0
}

/** Immediately kills every surviving owned process group after a repeated interrupt. */
export function killProcessGroups(groupIds, killProcess = process.kill) {
  for (const groupId of validGroupIds(groupIds))
    signalProcessGroup(groupId, "SIGKILL", killProcess)
}

/**
 * Stops owned process groups when the launcher is interrupted or loses its terminal.
 * The exit hook is a synchronous fallback for unexpected launcher failures.
 */
export function registerLauncherShutdown(
  groupIds,
  stop,
  {
    runtime = process,
    platform = process.platform,
    killProcess = process.kill,
  } = {}
) {
  runtime.on("SIGINT", () => stop("SIGINT"))
  runtime.on("SIGTERM", () => stop("SIGTERM"))
  if (platform !== "win32") {
    runtime.on("SIGHUP", () => stop("SIGTERM", 129))
    runtime.once("exit", () => killProcessGroups(groupIds, killProcess))
  }
}
