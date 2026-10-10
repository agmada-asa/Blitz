/** Exercises worker deadlines, forced cleanup, idle release, and process-generation isolation. */

import assert from "node:assert/strict"
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { PassThrough } from "node:stream"
import { setTimeout as pause } from "node:timers/promises"
import test from "node:test"
import {
  KokoroWorker,
  type KokoroRequest,
} from "../lib/server/kokoro-worker.ts"

/** Valid protocol input; tests never write actual speech audio. */
const request: KokoroRequest = {
  text: "Hello.",
  voiceId: "af_heart",
  outputPath: "/tmp/test-speech.wav",
}

/** Models a child that may ignore graceful termination and emit delayed protocol replies. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 100
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stubborn = false
  signals: NodeJS.Signals[] = []
  requests: KokoroRequest[] = []

  /** Records writes so a test can complete, reject, or stall the matching inference. */
  constructor() {
    super()
    this.stdin.on("data", (chunk: Buffer) =>
      this.requests.push(JSON.parse(chunk.toString()) as KokoroRequest)
    )
  }

  /** Emits one newline-delimited reply as the Python process would. */
  reply(message: object): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** Records signals, allowing stubborn children to survive SIGTERM until escalation. */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal)
    this.killed = true
    if (!this.stubborn || signal === "SIGKILL")
      queueMicrotask(() => this.exit(null, signal))
    return true
  }

  /** Completes the child exit once and leaves stdout available for deliberate stale replies. */
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

/** Creates a test runtime with automatically ready child processes and short bounded deadlines. */
function harness(
  options: Partial<ConstructorParameters<typeof KokoroWorker>[0]> = {}
) {
  const children: FakeChild[] = []
  const runtime = new KokoroWorker({
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    shutdownGraceMs: 10,
    spawnWorker: () => {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => child.reply({ ready: true }))
      return child as unknown as ChildProcessWithoutNullStreams
    },
    ...options,
  })
  return { runtime, children }
}

test("shares startup and sequential requests without starting multiple models", async (t) => {
  const { runtime, children } = harness()
  t.after(() => runtime.killNow())
  await Promise.all([runtime.start(), runtime.start()])
  assert.equal(children.length, 1)
  const first = runtime.synthesize(request)
  await pause(0)
  assert.deepEqual(children[0].requests, [request])
  children[0].reply({ ok: true })
  await first
  const second = runtime.synthesize({ ...request, text: "Again." })
  await pause(0)
  children[0].reply({ ok: true })
  await second
  assert.equal(children.length, 1)
})

test("times out stuck inference, force-kills it, and recovers on the next request", async (t) => {
  const { runtime, children } = harness({ requestTimeoutMs: 20 })
  t.after(() => runtime.killNow())
  await runtime.start()
  children[0].stubborn = true
  await assert.rejects(runtime.synthesize(request), /took too long/)
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"])
  assert.equal(children[0].signalCode, "SIGKILL")
  const next = runtime.synthesize(request)
  await pause(0)
  assert.equal(children.length, 2)
  children[0].reply({ ok: true })
  children[1].reply({ ok: true })
  await next
})

test("times out startup and waits for a stubborn process to exit before replacing it", async (t) => {
  const children: FakeChild[] = []
  const { runtime } = harness({
    startupTimeoutMs: 20,
    spawnWorker: () => {
      const child = new FakeChild()
      child.stubborn = true
      children.push(child)
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  t.after(() => runtime.killNow())
  await assert.rejects(runtime.start(), /too long to start/)
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"])
  const next = runtime.start()
  await pause(0)
  children[1].reply({ ready: true })
  await next
})

test("failed readiness cleans up the process instead of leaving an unused model running", async (t) => {
  const child = new FakeChild()
  const { runtime } = harness({
    spawnWorker: () => child as unknown as ChildProcessWithoutNullStreams,
  })
  t.after(() => runtime.killNow())
  const starting = runtime.start()
  const rejected = assert.rejects(starting, /missing model/)
  await pause(0)
  child.reply({ ready: false, error: "missing model" })
  await rejected
  assert.equal(child.signalCode, "SIGTERM")
})

test("a missing Python executable rejects startup without waiting forever for an exit event", async (t) => {
  const child = new FakeChild()
  child.pid = undefined
  const { runtime } = harness({
    spawnWorker: () => child as unknown as ChildProcessWithoutNullStreams,
  })
  t.after(() => runtime.killNow())
  const starting = runtime.start()
  const rejected = assert.rejects(starting, /not installed/)
  await pause(0)
  child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))
  await rejected
  assert.deepEqual(child.signals, [])
})

test("idle warmup releases the model and the next request starts it again", async (t) => {
  const { runtime, children } = harness({ idleTimeoutMs: 20 })
  t.after(() => runtime.killNow())
  await runtime.start()
  await pause(40)
  assert.equal(children[0].signalCode, "SIGTERM")
  const next = runtime.synthesize(request)
  await pause(0)
  children[1].reply({ ok: true })
  await next
  assert.equal(children.length, 2)
})

test("idle shutdown never interrupts inference and its deadline resets after completion", async (t) => {
  const { runtime, children } = harness({ idleTimeoutMs: 30 })
  t.after(() => runtime.killNow())
  const active = runtime.synthesize(request)
  await pause(45)
  assert.deepEqual(children[0].signals, [])
  children[0].reply({ ok: true })
  await active
  await pause(10)
  assert.deepEqual(children[0].signals, [])
  await pause(35)
  assert.equal(children[0].signalCode, "SIGTERM")
})

test("a failed inference is terminated and cannot complete a replacement's request", async (t) => {
  const { runtime, children } = harness()
  t.after(() => runtime.killNow())
  const first = runtime.synthesize(request)
  const rejected = assert.rejects(first, /bad voice/)
  await pause(0)
  children[0].reply({ ok: false, error: "bad voice" })
  await rejected
  const next = runtime.synthesize(request)
  let completed = false
  const finished = next.then(() => {
    completed = true
  })
  await pause(0)
  children[0].reply({ ok: true })
  await pause(0)
  assert.equal(completed, false)
  children[1].reply({ ok: true })
  await finished
})

test("unexpected exit rejects the active request and permits recovery", async (t) => {
  const { runtime, children } = harness()
  t.after(() => runtime.killNow())
  const active = runtime.synthesize(request)
  const rejected = assert.rejects(active, /worker stopped/)
  await pause(0)
  children[0].exit(1)
  await rejected
  await runtime.start()
  assert.equal(children.length, 2)
})

test("a broken input pipe rejects inference and cleans up without crashing the server", async (t) => {
  const { runtime, children } = harness()
  t.after(() => runtime.killNow())
  const active = runtime.synthesize(request)
  const rejected = assert.rejects(active, /stopped accepting requests/)
  await pause(0)
  children[0].stdin.emit(
    "error",
    Object.assign(new Error("broken pipe"), { code: "EPIPE" })
  )
  await rejected
  assert.equal(children[0].signalCode, "SIGTERM")
  await runtime.start()
  assert.equal(children.length, 2)
})

test("server exit force-kills speech rather than trusting graceful native shutdown", async () => {
  const { runtime, children } = harness()
  await runtime.start()
  children[0].stubborn = true
  runtime.killNow()
  await pause(0)
  assert.deepEqual(children[0].signals, ["SIGKILL"])
})

test(
  "a real process that ignores SIGTERM is gone before a timed-out request returns",
  { timeout: 5_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); console.log(JSON.stringify({ready:true})); process.stdin.resume()',
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    )
    t.after(() => child.kill("SIGKILL"))
    const runtime = new KokoroWorker({
      spawnWorker: () => child,
      requestTimeoutMs: 30,
      shutdownGraceMs: 20,
    })
    await assert.rejects(runtime.synthesize(request), /took too long/)
    assert.equal(child.signalCode, "SIGKILL")
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" })
  }
)

test("a real missing executable fails startup without leaking timers", async () => {
  const runtime = new KokoroWorker({
    spawnWorker: () =>
      spawn("/definitely-missing-blitz-python", [], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
  })
  await assert.rejects(runtime.start(), /not installed/)
})

test(
  "Python stops stalled inference after its Node parent is abruptly killed",
  { timeout: 8_000 },
  async (t) => {
    if (spawnSync("python3", ["--version"]).error) {
      t.skip("Python is not installed on this host.")
      return
    }
    const fixture = fileURLToPath(
      new URL("./fixtures/kokoro-parent-loss.py", import.meta.url)
    )
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
    const {spawn} = require("node:child_process");
    const worker = spawn("python3", [process.argv[1]], {
      env: {...process.env, BLITZ_KOKORO_DIR: "/unused-test-model"},
      stdio: ["pipe", "pipe", "inherit"],
    });
    console.log(JSON.stringify({pid: worker.pid}));
    worker.stdout.pipe(process.stdout);
    worker.stdin.write(JSON.stringify({text:"Stall.",voiceId:"af_heart",outputPath:"/tmp/unused.wav"}) + "\\n");
  `,
        fixture,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    )
    let workerPid: number | undefined
    t.after(() => {
      parent.kill("SIGKILL")
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGKILL")
        } catch {}
      }
    })
    const lines = createInterface({ input: parent.stdout })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture did not start stalled inference.")),
        3_000
      )
      lines.on("line", (line) => {
        const message = JSON.parse(line) as { pid?: number; busy?: boolean }
        if (message.pid) workerPid = message.pid
        if (message.busy) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    assert.ok(workerPid)
    parent.kill("SIGKILL")
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      try {
        process.kill(workerPid, 0)
      } catch {
        return
      }
      await pause(25)
    }
    assert.fail("Orphaned Python inference remained alive after parent loss.")
  }
)
