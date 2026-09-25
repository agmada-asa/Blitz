/** Verifies that local launcher shutdown cleans up complete process groups. */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import {
  processGroupExists,
  registerLauncherShutdown,
  signalProcessGroup,
  terminateProcessGroups,
} from "../scripts/process-groups.mjs"

/** Creates the error shape returned when a Unix process group no longer exists. */
function missingGroupError(): NodeJS.ErrnoException {
  const error = new Error("No such process group") as NodeJS.ErrnoException
  error.code = "ESRCH"
  return error
}

test("stops responsive process groups without forcing them", async () => {
  const alive = new Set([101, 102])
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const killProcess = (pid: number, signal: NodeJS.Signals | 0): true => {
    const groupId = Math.abs(pid)
    signals.push([pid, signal])
    if (!alive.has(groupId)) throw missingGroupError()
    if (signal !== 0) alive.delete(groupId)
    return true
  }

  const forced = await terminateProcessGroups([101, 102], { killProcess })

  assert.equal(forced, false)
  assert.deepEqual(signals, [
    [-101, "SIGTERM"],
    [-102, "SIGTERM"],
    [-101, 0],
    [-102, 0],
  ])
})

test("force-kills a process group that survives the grace period", async () => {
  const alive = new Set([201])
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const killProcess = (pid: number, signal: NodeJS.Signals | 0): true => {
    signals.push([pid, signal])
    if (!alive.has(Math.abs(pid))) throw missingGroupError()
    if (signal === "SIGKILL") alive.delete(Math.abs(pid))
    return true
  }

  const forced = await terminateProcessGroups([201], {
    graceMs: 0,
    killProcess,
  })

  assert.equal(forced, true)
  assert.deepEqual(signals, [
    [-201, "SIGTERM"],
    [-201, 0],
    [-201, "SIGKILL"],
  ])
})

test("treats an exited process group as absent", () => {
  const killProcess = () => {
    throw missingGroupError()
  }

  assert.equal(processGroupExists(301, killProcess), false)
  assert.equal(signalProcessGroup(301, "SIGTERM", killProcess), false)
})

test("terminal loss requests shutdown and exit kills surviving groups", () => {
  const runtime = new EventEmitter() as unknown as NodeJS.Process
  const stops: Array<[string, number | undefined]> = []
  const signals: Array<[number, string]> = []

  registerLauncherShutdown(
    new Set([401, 402]),
    (signal: string, exitCode?: number) => stops.push([signal, exitCode]),
    {
      runtime,
      platform: "darwin",
      killProcess: (pid: number, signal: string) => {
        signals.push([pid, signal])
        return true
      },
    }
  )

  runtime.emit("SIGHUP")
  assert.deepEqual(stops, [["SIGTERM", 129]])

  runtime.emit("exit", 0)
  assert.deepEqual(signals, [
    [-401, "SIGKILL"],
    [-402, "SIGKILL"],
  ])
})

test("unexpected launcher exit kills its child group without a prior signal", () => {
  const runtime = new EventEmitter() as unknown as NodeJS.Process
  const signals: Array<[number, string]> = []

  registerLauncherShutdown(new Set([501]), () => {}, {
    runtime,
    platform: "darwin",
    killProcess: (pid: number, signal: string) => {
      signals.push([pid, signal])
      return true
    },
  })

  runtime.emit("exit", 0)
  assert.deepEqual(signals, [[-501, "SIGKILL"]])
})
