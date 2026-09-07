/** Verifies normalized Claude Code and ACP provider streams with in-memory processes. */

import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import test from "node:test"

import {
  runAcpTextTurn,
  type AcpChildProcess,
} from "../lib/server/providers/acp.ts"
import {
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
  private respond(message: { id?: number; method?: string }): void {
    if (message.method === "initialize") {
      this.send({ jsonrpc: "2.0", id: message.id, result: {} })
      return
    }
    if (message.method === "session/new") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "acp-session-1" },
      })
      return
    }
    if (message.method === "session/prompt") {
      this.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP answer" },
          },
        },
      })
      this.send({ jsonrpc: "2.0", id: message.id, result: {} })
    }
  }

  /** Writes one newline-delimited JSON-RPC message to the fake provider stream. */
  private send(message: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify(message)}\n`)
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
