/** Verifies desktop service recovery and shutdown with in-memory child processes. */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { ServiceManager } from "../electron/service-manager.mjs"

/** Creates a child-process double that exits when its signal method is called. */
function fakeChild(
  pid: number
): EventEmitter & { pid: number; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: () => void
  }
  child.pid = pid
  child.kill = () => child.emit("exit", 0, null)
  return child
}

test("restarts one failed worker and then bounds further recovery", async () => {
  const children: Array<ReturnType<typeof fakeChild>> = []
  const byPid = new Map<number, ReturnType<typeof fakeChild>>()
  const healthUrls: string[] = []
  const manager = new ServiceManager({
    cwd: process.cwd(),
    port: 43210,
    spawnProcess: () => {
      const child = fakeChild(children.length + 1)
      children.push(child)
      byPid.set(child.pid, child)
      return child
    },
    fetchImpl: async (url) => {
      healthUrls.push(url)
      return { ok: true, status: 200 }
    },
    workerRestartDelayMs: 1,
    healthIntervalMs: 1,
    shutdownGraceMs: 5,
    killProcess: (pid: number) =>
      byPid.get(Math.abs(pid))?.emit("exit", 0, null),
  })

  await manager.start()
  assert.equal(children.length, 6)
  assert.ok(healthUrls.some((url) => url.endsWith(":3210")))
  children[2].emit("exit", 1, null)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(children.length, 7)
  assert.equal(manager.snapshot().ingestion, "starting")
  children[6].emit("exit", 1, null)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.match(manager.snapshot().ingestion, /^stopped/)
  await manager.stop()
})

test("stops all managed child groups and marks them stopped", async () => {
  const children: Array<ReturnType<typeof fakeChild>> = []
  const byPid = new Map<number, ReturnType<typeof fakeChild>>()
  const manager = new ServiceManager({
    cwd: process.cwd(),
    spawnProcess: () => {
      const child = fakeChild(children.length + 1)
      children.push(child)
      byPid.set(child.pid, child)
      return child
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    shutdownGraceMs: 5,
    killProcess: (pid: number) =>
      byPid.get(Math.abs(pid))?.emit("exit", 0, null),
  })
  await manager.start()
  await manager.stop()
  assert.deepEqual(
    Object.values(manager.snapshot()).filter((status) => status === "stopped")
      .length,
    6
  )
})
