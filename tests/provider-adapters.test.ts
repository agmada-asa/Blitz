/** Verifies normalized Claude Code and ACP provider streams with in-memory processes. */

import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import test from "node:test"

import {
  runAcpTextTurn,
  type AcpChildProcess,
} from "../lib/server/providers/acp.ts"
import {
  claudeArgs,
  runClaudeCodeTextTurn,
  type ClaudeCodeChildProcess,
} from "../lib/server/providers/claude-code.ts"

/** Emits provider output through the small stream surface used by the Claude adapter. */
class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false

  /** Records termination without adding process output to the fixture. */
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** Satisfies the ACP child shape while replying to the protocol messages under test. */
class FakeAcpProcess extends EventEmitter {
  capabilities: Record<string, unknown> = {}
  methods: string[] = []
  answer = "ACP answer"
  splitBytes = false
  overflowLine = false
  repeat = 1

  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = {
    write: (chunk: string): boolean => {
      const message = JSON.parse(chunk) as {
        id?: number
        method?: string
      }
      queueMicrotask(() => this.respond(message))
      return true
    },
    end: (): void => undefined,
    on: (): void => undefined,
  }
  killed = false

  /** Replies to initialization and a single prompt while streaming one text chunk. */
  protected respond(message: { id?: number; method?: string }): void {
    if (message.method) this.methods.push(message.method)
    if (message.method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: this.capabilities },
      })
      return
    }
    if (
      message.method === "session/new" ||
      message.method === "session/load" ||
      message.method === "session/resume"
    ) {
      if (message.method === "session/load")
        this.send({
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Historical answer" },
            },
          },
        })
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "acp-session-1" },
      })
      return
    }
    if (message.method === "session/prompt") {
      if (this.overflowLine) {
        this.stdout.emit("data", Buffer.alloc(1_000_001, 32))
        return
      }
      for (let index = 0; index < this.repeat; index++)
        this.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: this.answer },
            },
          },
        })
      this.send({ jsonrpc: "2.0", id: message.id, result: {} })
    }
  }

  /** Writes one newline-delimited JSON-RPC message to the fake provider stream. */
  protected send(message: Record<string, unknown>): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`)
    if (this.splitBytes) {
      for (const byte of bytes) this.stdout.emit("data", Buffer.from([byte]))
    } else this.stdout.emit("data", bytes)
  }

  /** Records termination without producing a fake close event. */
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** Confirms Claude stream-json deltas are normalized without duplicating the final result. */
test("normalizes Claude Code streaming output", async () => {
  const child = new FakeClaudeProcess()
  const events: unknown[] = []
  const resultPromise = runClaudeCodeTextTurn(
    {
      selection: {
        providerId: "claude-code",
        model: "claude-sonnet",
      },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Answer briefly.",
    },
    {
      command: { executable: "claude", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child as unknown as ClaudeCodeChildProcess,
      onEvent: (event) => events.push(event),
    }
  )
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "content_block_delta",
        delta: { text: "Claude answer" },
      },
    })}\n`
  )
  child.stdout.emit(
    "data",
    `${JSON.stringify({
      type: "result",
      session_id: "claude-session-1",
      result: "Claude answer",
    })}\n`
  )
  child.emit("close", 0)
  const result = await resultPromise
  assert.equal(result.threadId, "claude-session-1")
  assert.equal(result.text, "Claude answer")
  assert.equal(
    events.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "text-delta"
    ).length,
    1
  )
})

/** Confirms ACP session startup, streamed text, and normalized turn identity. */
test("normalizes ACP provider output", async () => {
  const child = new FakeAcpProcess()
  const events: Array<{ type: string; turnId?: string }> = []
  const result = await runAcpTextTurn(
    {
      selection: {
        providerId: "opencode",
        model: "default",
      },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Answer briefly.",
    },
    {
      command: { executable: "opencode", args: ["acp"] },
      providerInstanceId: "local",
      spawnProcess: () => child as unknown as AcpChildProcess,
      onEvent: (event) => events.push(event),
    }
  )
  assert.equal(result.threadId, "acp-session-1")
  assert.equal(result.text, "ACP answer")
  assert.ok(
    events.some(
      (event) => event.type === "turn-started" && event.turnId === result.turnId
    )
  )
  assert.ok(
    events.some(
      (event) => event.type === "text-delta" && event.turnId === result.turnId
    )
  )
})

/** Builds one ACP request with a fake executable and no external model usage. */
function acpTurn(child: FakeAcpProcess, resume = false) {
  return runAcpTextTurn(
    {
      selection: { providerId: "opencode", model: "default" },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Current question",
      ...(resume
        ? {
            session: {
              providerId: "opencode" as const,
              providerSessionId: "acp-session-1",
            },
          }
        : {}),
    },
    {
      command: { executable: "opencode", args: ["acp"] },
      providerInstanceId: "local",
      spawnProcess: () => child,
    }
  )
}

test("ACP preserves every split UTF-8 byte", async () => {
  const child = new FakeAcpProcess()
  child.answer = "Café 中文 🧠"
  child.splitBytes = true
  assert.equal((await acpTurn(child)).text, child.answer)
})

test("ACP rejects an unterminated oversized line and stops its process", async () => {
  const child = new FakeAcpProcess()
  child.overflowLine = true
  await assert.rejects(acpTurn(child), /line limit/)
  assert.equal(child.killed, true)
})

test("ACP bounds cumulative assistant output across small messages", async () => {
  const child = new FakeAcpProcess()
  child.answer = "x".repeat(10_000)
  child.repeat = 26
  await assert.rejects(acpTurn(child), /response was invalid/)
  assert.equal(child.killed, true)
})

test("ACP negotiates load and excludes replayed assistant history", async () => {
  const child = new FakeAcpProcess()
  child.capabilities = { loadSession: true }
  assert.equal((await acpTurn(child, true)).text, "ACP answer")
  assert.ok(child.methods.includes("session/load"))
})

test("ACP uses advertised resume without assuming load support", async () => {
  const child = new FakeAcpProcess()
  child.capabilities = { sessionCapabilities: { resume: {} } }
  await acpTurn(child, true)
  assert.ok(child.methods.includes("session/resume"))
  assert.ok(!child.methods.includes("session/load"))
})

test("ACP without resume capabilities fails before accepting a turn so chat can replay", async () => {
  const child = new FakeAcpProcess()
  await assert.rejects(acpTurn(child, true), /replay the conversation/)
  assert.deepEqual(child.methods, ["initialize"])
})

test("ACP refuses restricted source work before spawning", async () => {
  let spawned = false
  await assert.rejects(
    runAcpTextTurn(
      {
        selection: { providerId: "opencode", model: "default" },
        workspaceDirectory: "/tmp/blitz-provider-test",
        prompt: "Untrusted source",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
      {
        command: { executable: "opencode", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => {
          spawned = true
          return new FakeAcpProcess()
        },
      }
    ),
    /cannot enforce/
  )
  assert.equal(spawned, false)
})

test("Claude normalizes saved aliases, passes effort, and removes tool access", () => {
  for (const model of ["sonnet", "opus", "haiku"]) {
    const args = claudeArgs({
      selection: {
        providerId: "claude-code",
        model: `claude-${model}`,
        effort: model === "haiku" ? "default" : "high",
      },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Source",
      ephemeral: true,
    })
    assert.equal(args[args.indexOf("--model") + 1], model)
    assert.equal(args.includes("--effort"), model !== "haiku")
    assert.ok(args.includes("--restricted"))
    assert.ok(args.includes("--safe-mode"))
    assert.ok(args.includes("--no-session-persistence"))
    assert.equal(args[args.indexOf("--tools") + 1], "")
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "*")
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk")
  }
})

/** Starts a fake Claude turn for parser and lifecycle failure regression tests. */
function claudeTurn(child: FakeClaudeProcess, timeoutMs = 1000) {
  return runClaudeCodeTextTurn(
    {
      selection: { providerId: "claude-code", model: "sonnet" },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Question",
      timeoutMs,
    },
    {
      command: { executable: "claude", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
    }
  )
}

test("Claude output overflow rejects asynchronously without a close event", async () => {
  const child = new FakeClaudeProcess()
  const result = claudeTurn(child)
  assert.doesNotThrow(() =>
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({ type: "result", result: "x".repeat(250_001) }) + "\n"
      )
    )
  )
  await assert.rejects(result, /output exceeded/)
  assert.equal(child.killed, true)
})

test("Claude bounds unterminated output and still times out after stdout ends", async () => {
  const child = new FakeClaudeProcess()
  const result = claudeTurn(child)
  child.stdout.emit("data", Buffer.alloc(2_000_001, 32))
  await assert.rejects(result, /stream exceeded/)
  const stalled = new FakeClaudeProcess()
  const timeout = claudeTurn(stalled, 10)
  stalled.stdout.emit("end")
  await assert.rejects(timeout, /timed out/)
  assert.equal(stalled.killed, true)
})

test("Claude flushes the final JSON line and preserves split UTF-8", async () => {
  const child = new FakeClaudeProcess()
  const result = claudeTurn(child)
  const answer = "Café 中文 🧠"
  for (const byte of Buffer.from(
    JSON.stringify({ type: "result", result: answer })
  ))
    child.stdout.emit("data", Buffer.from([byte]))
  child.stdout.emit("end")
  child.emit("close", 0)
  assert.equal((await result).text, answer)
})

/** Unsupported approval policies fail before any process can consume source material. */
test("Claude rejects interactive approval policies without spawning", async () => {
  let spawned = false
  await assert.rejects(
    runClaudeCodeTextTurn(
      {
        selection: { providerId: "claude-code", model: "sonnet" },
        workspaceDirectory: "/tmp/blitz-provider-test",
        prompt: "Source",
        approvalPolicy: "on-request",
      },
      {
        command: { executable: "claude", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => {
          spawned = true
          return new FakeClaudeProcess()
        },
      }
    ),
    /only supports never-approve/
  )
  assert.equal(spawned, false)
})
