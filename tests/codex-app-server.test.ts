/**
 * Verifies the Codex app-server JSONL transport with an in-memory child
 * process. The fixture never starts Codex or consumes subscription usage.
 */

import { EventEmitter } from "node:events"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CodexAppServerClient,
  CodexProtocolError,
  type CodexChildProcess,
  type CodexReadable,
  type CodexWritable,
} from "../lib/server/codex-app-server.ts"

/** In-memory stdout/stderr stream used by the fake child process. */
class FakeReadable extends EventEmitter implements CodexReadable {
  /** Emits a child stdout chunk. */
  emitChunk(chunk: string | Buffer): void {
    this.emit("data", chunk)
  }

  /** Marks the child stream as ended. */
  emitEnd(): void {
    this.emit("end")
  }
}

/** In-memory stdin used by the fake child process. */
class FakeWritable extends EventEmitter implements CodexWritable {
  /** Serialized messages written by the client. */
  readonly writes: string[] = []
  /** Whether the client closed stdin. */
  ended = false

  /** Records one serialized JSONL write. */
  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }

  /** Records stdin closure. */
  end(): void {
    this.ended = true
  }
}

/** Minimal controllable child process with protocol message helpers. */
class FakeProcess extends EventEmitter implements CodexChildProcess {
  /** Fake stdin. */
  readonly stdin = new FakeWritable()
  /** Fake stdout. */
  readonly stdout = new FakeReadable()
  /** Fake stderr. */
  readonly stderr = new FakeReadable()
  /** Number of termination requests. */
  killCount = 0

  /** Records a termination request without ending the fixture automatically. */
  kill(): boolean {
    this.killCount += 1
    return true
  }

  /** Emits one decoded server response as newline-delimited JSON. */
  respond(message: unknown): void {
    this.stdout.emitChunk(`${JSON.stringify(message)}\n`)
  }

  /** Emits one raw stdout line for malformed protocol tests. */
  emitRaw(line: string): void {
    this.stdout.emitChunk(`${line}\n`)
  }

  /** Emits the child close event. */
  close(code = 0, signal: string | null = null): void {
    this.emit("close", code, signal)
  }
}

/** Reads all messages written to fake stdin. */
function messages(process: FakeProcess): Array<Record<string, unknown>> {
  return process.stdin.writes.map(
    (line) => JSON.parse(line) as Record<string, unknown>
  )
}

/** Completes the initialize request emitted by `connect`. */
function initialize(process: FakeProcess): void {
  process.respond({ id: 1, result: { platformFamily: "macos" } })
}

test("performs the handshake, correlates out-of-order replies, and uses the supplied workspace", async () => {
  const process = new FakeProcess()
  let workspace = ""
  const connecting = CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: (directory) => {
      workspace = directory
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  const client = await connecting
  try {
    const writtenAfterHandshake = messages(process)
    assert.equal(writtenAfterHandshake[0]?.method, "initialize")
    assert.equal(writtenAfterHandshake[1]?.method, "initialized")
    assert.equal(workspace, "/tmp/blitz-owned-workspace")

    const first = client.startThread({ model: "gpt-test" })
    const second = client.resumeThread("thr_existing")
    const pending = messages(process).slice(2)
    const firstRequest = pending.find(
      (message) => message.method === "thread/start"
    )
    const secondRequest = pending.find(
      (message) => message.method === "thread/resume"
    )
    assert.equal(
      firstRequest?.params &&
        (firstRequest.params as Record<string, unknown>).cwd,
      workspace
    )
    assert.equal(
      firstRequest?.params &&
        (firstRequest.params as Record<string, unknown>).approvalPolicy,
      "on-request"
    )
    assert.equal(
      firstRequest?.params &&
        (firstRequest.params as Record<string, unknown>).sandbox,
      "read-only"
    )
    assert.equal(
      secondRequest?.params &&
        (secondRequest.params as Record<string, unknown>).threadId,
      "thr_existing"
    )
    assert.equal(
      secondRequest?.params &&
        (secondRequest.params as Record<string, unknown>).approvalPolicy,
      "on-request"
    )
    assert.equal(
      secondRequest?.params &&
        (secondRequest.params as Record<string, unknown>).sandbox,
      "read-only"
    )

    process.respond({
      id: secondRequest?.id,
      result: { thread: { id: "thr_existing" } },
    })
    process.respond({
      id: firstRequest?.id,
      result: { thread: { id: "thr_new" } },
    })
    assert.equal((await first).thread.id, "thr_new")
    assert.equal((await second).thread.id, "thr_existing")
  } finally {
    await client.close()
  }
})

test("preserves UTF-8 characters split across stdout chunks", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  try {
    const resumed = client.resumeThread("thr_spanish")
    const request = messages(process).at(-1)
    const line = Buffer.from(
      `${JSON.stringify({ id: request?.id, result: { thread: { id: "thr_spanish", name: "Español café" } } })}\n`
    )
    const split = line.indexOf(Buffer.from("ñ")) + 1
    process.stdout.emitChunk(line.subarray(0, split))
    process.stdout.emitChunk(line.subarray(split))
    const thread = (await resumed).thread
    assert.equal(thread.name, "Español café")
  } finally {
    await client.close()
  }
})

test("starts and interrupts a turn using server-issued identifiers", async () => {
  const process = new FakeProcess()
  const clientPromise = CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  const client = await clientPromise
  try {
    const turnPromise = client.startTurn("thr_1", { text: "hello" })
    const turnRequest = messages(process).at(-1)
    process.respond({
      id: turnRequest?.id,
      result: { turn: { id: "turn_1", status: "inProgress" } },
    })
    assert.equal((await turnPromise).turn.id, "turn_1")

    const interruptPromise = client.interruptTurn("thr_1", "turn_1")
    const interruptRequest = messages(process).at(-1)
    assert.equal(interruptRequest?.method, "turn/interrupt")
    process.respond({ id: interruptRequest?.id, result: {} })
    await interruptPromise
  } finally {
    await client.close()
  }
})

test("declines approval requests by default and surfaces them to observers", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  try {
    const events: string[] = []
    client.onEvent((event) => {
      if (event.type === "server-request") events.push(event.request.method)
    })
    process.respond({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "item-1", threadId: "thr-1", turnId: "turn-1" },
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const response = messages(process).at(-1)
    assert.deepEqual(response, {
      id: "approval-1",
      result: { decision: "decline" },
    })
    assert.deepEqual(events, ["item/commandExecution/requestApproval"])
  } finally {
    await client.close()
  }
})

test("propagates app-server errors and rejects pending calls when the process exits", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  try {
    const failed = client.resumeThread("thr_missing")
    const request = messages(process).at(-1)
    process.respond({
      id: request?.id,
      error: { code: -32000, message: "missing thread" },
    })
    await assert.rejects(failed, /missing thread/)

    const pending = client.resumeThread("thr_exiting")
    process.close(1, null)
    await assert.rejects(pending, /process exited/)
  } finally {
    await client.close()
  }
})

test("fails safely on malformed JSONL", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    maxLineBytes: 64,
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  try {
    const malformed = client.resumeThread("thr_bad")
    process.emitRaw("not-json")
    await assert.rejects(malformed, CodexProtocolError)
    assert.equal(process.killCount, 1)
  } finally {
    await client.close()
  }
})

test("times out a request and terminates the connection", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    requestTimeoutMs: 10,
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  const pending = client.resumeThread("thr_slow")
  await assert.rejects(pending, /timed out/)
  assert.equal(process.killCount, 1)
  await client.close()
})

test("fails pending requests when stdin reports a broken pipe", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  const pending = client.resumeThread("thr_pipe")
  process.stdin.emit("error", new Error("EPIPE"))
  await assert.rejects(pending, /EPIPE/)
  assert.equal(process.killCount, 1)
  await client.close()
})

test("rejects an inbound JSONL line beyond the configured bound", async () => {
  const process = new FakeProcess()
  const client = await CodexAppServerClient.connect({
    workspaceDirectory: "/tmp/blitz-owned-workspace",
    maxLineBytes: 64,
    spawnProcess: () => {
      queueMicrotask(() => initialize(process))
      return process
    },
  })
  const pending = client.resumeThread("thr_large")
  process.emitRaw("x".repeat(65))
  await assert.rejects(pending, CodexProtocolError)
  assert.equal(process.killCount, 1)
  await client.close()
})

test("rejects a missing or relative workspace before starting a process", async () => {
  await assert.rejects(
    CodexAppServerClient.connect({ workspaceDirectory: "relative" }),
    /absolute workspaceDirectory/
  )

  let spawned = false
  await assert.rejects(
    CodexAppServerClient.connect({
      workspaceDirectory: "/tmp/blitz-owned-workspace",
      requestTimeoutMs: 0,
      spawnProcess: () => {
        spawned = true
        return new FakeProcess()
      },
    }),
    /requestTimeoutMs must be a positive integer/
  )
  assert.equal(spawned, false)
})
