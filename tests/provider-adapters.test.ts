/** Verifies normalized Claude Code and ACP provider streams with in-memory processes. */

import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import test from "node:test"

import {
  inspectAcpAuthentication,
  parseAcpModelOptions,
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
  authMethods: Record<string, unknown>[] = []
  methods: string[] = []
  answer = "ACP answer"
  splitBytes = false
  overflowLine = false
  repeat = 1
  sessionResult: Record<string, unknown> = { sessionId: "acp-session-1" }
  configSelections: Array<{
    sessionId?: string
    configId?: string
    value?: string
  }> = []
  modeSelections: Array<{ sessionId?: string; modeId?: string }> = []

  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = {
    write: (chunk: string): boolean => {
      const message = JSON.parse(chunk) as {
        id?: number
        method?: string
        params?: {
          sessionId?: string
          configId?: string
          value?: string
          modeId?: string
        }
      }
      queueMicrotask(() => this.respond(message))
      return true
    },
    end: (): void => undefined,
    on: (): void => undefined,
  }
  killed = false

  /** Replies to initialization and a single prompt while streaming one text chunk. */
  protected respond(message: {
    id?: number
    method?: string
    params?: {
      sessionId?: string
      configId?: string
      value?: string
      modeId?: string
    }
  }): void {
    if (message.method) this.methods.push(message.method)
    if (message.method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: this.capabilities,
          authMethods: this.authMethods,
        },
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
        result: this.sessionResult,
      })
      return
    }
    if (message.method === "session/set_config_option") {
      this.configSelections.push(message.params ?? {})
      this.send({ jsonrpc: "2.0", id: message.id, result: {} })
      return
    }
    if (message.method === "session/set_mode") {
      this.modeSelections.push(message.params ?? {})
      this.send({ jsonrpc: "2.0", id: message.id, result: {} })
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

/** Confirms ACP inspection returns provider-owned login choices and logout support. */
test("inspects ACP authentication methods without starting a model turn", async () => {
  const child = new FakeAcpProcess()
  child.capabilities = { auth: { logout: {} } }
  child.authMethods = [
    {
      id: "oauth-personal",
      name: "Log in with Google",
      description: "Use a Google account",
    },
  ]
  const result = await inspectAcpAuthentication(
    { executable: "fake-antigravity", args: [] },
    "/tmp/blitz-provider-test",
    { spawnProcess: () => child }
  )
  assert.equal(result.authenticated, null)
  assert.equal(result.canDisconnect, true)
  assert.deepEqual(result.authMethods, [
    {
      id: "oauth-personal",
      name: "Log in with Google",
      description: "Use a Google account",
      type: "agent",
    },
  ])
})

/** Confirms nested Antigravity choices retain native IDs and recognizable reasoning tiers. */
test("extracts Antigravity models from ACP session configuration", () => {
  assert.deepEqual(
    parseAcpModelOptions({
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          options: [
            {
              group: "Current",
              options: [
                { value: "gemini-flash-low", name: "Gemini Flash (Low)" },
                { value: "gemini-flash-high", name: "Gemini Flash (High)" },
              ],
            },
          ],
        },
      ],
    }),
    [
      {
        id: "gemini-flash-low",
        label: "Gemini Flash (Low)",
        reasoningEffort: "low",
      },
      {
        id: "gemini-flash-high",
        label: "Gemini Flash (High)",
        reasoningEffort: "high",
      },
    ]
  )
})

/** Confirms an explicit Antigravity variant is applied through its native model selector. */
test("applies an Antigravity model and encoded reasoning choice", async () => {
  const child = new FakeAcpProcess()
  await runAcpTextTurn(
    {
      selection: {
        providerId: "antigravity",
        model: "gemini-flash-high",
        effort: "high",
      },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Answer briefly.",
      sandbox: "danger-full-access",
      webSearchMode: "live",
    },
    {
      command: { executable: "fake-antigravity", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
    }
  )
  assert.deepEqual(child.configSelections, [
    {
      sessionId: "acp-session-1",
      configId: "model",
      value: "gemini-flash-high",
    },
  ])
})

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

/** Confirms Claude stream-json thinking deltas are emitted and thought is returned. */
test("normalizes Claude Code thinking deltas", async () => {
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
        delta: { type: "thinking_delta", thinking: "Pondering the query..." },
      },
    })}\n`
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
  assert.equal(result.thought, "Pondering the query...")
  assert.ok(typeof result.durationMs === "number")
  const thoughtEvents = events.filter(
    (event): event is { type: string; delta: string } =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "thought-delta"
  )
  assert.equal(thoughtEvents.length, 1)
  assert.equal(thoughtEvents[0].delta, "Pondering the query...")
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

/** Reapplies the selected native ACP mode after loading an existing conversation. */
test("ACP sets the current access mode before every resumed prompt", async () => {
  for (const [approvalPolicy, modeId] of [
    ["on-request", "default"],
    ["full-access", "yolo"],
  ] as const) {
    const child = new FakeAcpProcess()
    child.capabilities = { sessionCapabilities: { resume: {} } }
    await runAcpTextTurn(
      {
        selection: { providerId: "antigravity", model: "default" },
        workspaceDirectory: "/tmp/blitz-provider-test",
        prompt: "Use the current access mode.",
        session: {
          providerId: "antigravity",
          providerSessionId: "acp-session-1",
        },
        approvalPolicy,
        webSearchMode: "live",
      },
      {
        command: { executable: "fake-antigravity", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => child,
      }
    )
    assert.deepEqual(child.modeSelections, [
      { sessionId: "acp-session-1", modeId },
    ])
    assert.ok(
      child.methods.indexOf("session/set_mode") <
        child.methods.indexOf("session/prompt")
    )
  }
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

test("Antigravity refuses restricted source work before spawning", async () => {
  let spawned = false
  await assert.rejects(
    runAcpTextTurn(
      {
        selection: { providerId: "antigravity", model: "default" },
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
    /no tool-free ACP mode/
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

/** Pauses the prompt until the client resolves a provider permission request. */
class PermissionAcpProcess extends FakeAcpProcess {
  replies: unknown[] = []
  private promptMessage?: { id?: number; method?: string }
  options = [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
  ]
  sessionId = "acp-session-1"

  /** Reuses the active prompt ID to verify independent JSON-RPC request namespaces. */
  protected override respond(message: {
    id?: number
    method?: string
    result?: unknown
  }): void {
    if (message.method === "session/prompt") {
      this.promptMessage = message
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        method: "session/request_permission",
        params: {
          sessionId: this.sessionId,
          toolCall: {
            toolCallId: "tool-1",
            title: "Write a file",
            rawInput: { path: "answer.txt", content: "review me" },
          },
          options: this.options,
        },
      })
    } else if (!message.method && message.result) {
      this.replies.push(message.result)
      super.respond(this.promptMessage!)
    } else super.respond(message)
  }
}

/** Exercises permission decisions without a real model or filesystem action. */
test("ACP permissions grant only a reviewed invocation and deny missing or invalid reviews", async () => {
  for (const choice of [
    "approve",
    "deny",
    "missing",
    "throws",
    "wrong-session",
    "persistent-only",
  ] as const) {
    const child = new PermissionAcpProcess()
    if (choice === "wrong-session") child.sessionId = "another-session"
    if (choice === "persistent-only")
      child.options = [{ optionId: "always", kind: "allow_always" }]
    let reviews = 0
    await runAcpTextTurn(
      {
        selection: { providerId: "opencode", model: "default" },
        workspaceDirectory: "/tmp/blitz-test",
        prompt: "Question",
        approvalPolicy: "on-request",
      },
      {
        command: { executable: "fixture", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => child,
        approvalHandler:
          choice === "missing"
            ? undefined
            : async () => {
                reviews++
                if (choice === "throws") throw new Error("review failed")
                return choice === "approve"
              },
      }
    )
    assert.deepEqual(child.replies, [
      {
        outcome:
          choice === "approve"
            ? { outcome: "selected", optionId: "once" }
            : { outcome: "cancelled" },
      },
    ])
    if (choice === "wrong-session" || choice === "persistent-only")
      assert.equal(reviews, 0)
  }
})

/** Provides the bidirectional Claude SDK control protocol in memory. */
class PermissionClaudeProcess extends FakeClaudeProcess {
  responses: Record<string, unknown>[] = []
  readonly stdin = {
    write: (line: string): boolean => {
      const frame = JSON.parse(line)
      queueMicrotask(() => {
        if (frame.type === "control_request")
          this.stdout.emit(
            "data",
            JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: frame.request_id,
                response: {},
              },
            }) + "\n"
          )
        if (frame.type === "user")
          this.stdout.emit(
            "data",
            JSON.stringify({
              type: "control_request",
              request_id: "permission-1",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "echo reviewed" },
              },
            }) + "\n"
          )
        if (frame.type === "control_response") {
          this.responses.push(frame.response.response)
          this.stdout.emit(
            "data",
            JSON.stringify({
              type: "result",
              result: "Done",
              session_id: "claude-session",
            }) + "\n"
          )
          this.emit("close", 0)
        }
      })
      return true
    },
    end: (): void => undefined,
    on: (): void => undefined,
  }
}

/** Confirms the CLI waits for explicit approval and never receives a saved permission update. */
test("Claude bridges one-time tool approval and denial through its control channel", async () => {
  for (const allowed of [true, false]) {
    const child = new PermissionClaudeProcess()
    const result = await runClaudeCodeTextTurn(
      {
        selection: { providerId: "claude-code", model: "sonnet" },
        workspaceDirectory: "/tmp/blitz-test",
        prompt: "Question",
        approvalPolicy: "on-request",
      },
      {
        command: { executable: "fixture", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => child,
        approvalHandler: async (request) => {
          assert.equal(request.method, "claude/can_use_tool")
          return allowed
        },
      }
    )
    assert.equal(result.text, "Done")
    assert.deepEqual(child.responses, [
      allowed
        ? { behavior: "allow", updatedInput: { command: "echo reviewed" } }
        : { behavior: "deny", message: "Blitz denied this operation" },
    ])
  }
})

/** Background restrictions override saved full access, and interactive modes select real native flags. */
test("Claude maps access policies without weakening background turns", () => {
  const base = {
    selection: { providerId: "claude-code" as const, model: "sonnet" },
    workspaceDirectory: "/tmp/blitz-test",
    prompt: "Question",
  }
  const full = claudeArgs({ ...base, approvalPolicy: "full-access" })
  assert.ok(full.includes("--dangerously-skip-permissions"))
  assert.ok(!full.includes("--restricted"))
  const ask = claudeArgs({ ...base, approvalPolicy: "on-request" })
  assert.ok(ask.includes("--permission-prompt-tool"))
  assert.ok(!ask.includes("--dangerously-skip-permissions"))
  const background = claudeArgs({
    ...base,
    approvalPolicy: "full-access",
    ephemeral: true,
  })
  assert.equal(background[background.indexOf("--tools") + 1], "")
  assert.ok(!background.includes("--dangerously-skip-permissions"))
})

/** A pending review cannot grant a tool after the turn's deadline. */
test("Claude ignores approval resolutions that arrive after timeout", async () => {
  const child = new PermissionClaudeProcess()
  let resolveApproval: ((allowed: boolean) => void) | undefined
  const turn = runClaudeCodeTextTurn(
    {
      selection: { providerId: "claude-code", model: "sonnet" },
      workspaceDirectory: "/tmp/blitz-test",
      prompt: "Question",
      approvalPolicy: "on-request",
      timeoutMs: 20,
    },
    {
      command: { executable: "fixture", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
      approvalHandler: () =>
        new Promise<boolean>((resolve) => {
          resolveApproval = resolve
        }),
    }
  )
  await assert.rejects(turn, /timed out/)
  assert.ok(resolveApproval)
  resolveApproval(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(child.responses, [])
  assert.equal(child.killed, true)
})

/** Provider-side cancellation removes the pending review without issuing a late grant. */
test("Claude cancels the individual approval signal", async () => {
  const child = new PermissionClaudeProcess()
  let reviewSignal: AbortSignal | undefined
  const turn = runClaudeCodeTextTurn(
    {
      selection: { providerId: "claude-code", model: "sonnet" },
      workspaceDirectory: "/tmp/blitz-test",
      prompt: "Question",
      approvalPolicy: "on-request",
      timeoutMs: 1000,
    },
    {
      command: { executable: "fixture", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
      approvalHandler: (request) => {
        reviewSignal = request.signal
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            JSON.stringify({
              type: "control_cancel_request",
              request_id: "permission-1",
            }) + "\n"
          )
          child.stdout.emit(
            "data",
            JSON.stringify({ type: "result", result: "Cancelled the tool" }) +
              "\n"
          )
          child.emit("close", 0)
        })
        return new Promise<boolean>((resolve) =>
          request.signal!.addEventListener("abort", () => resolve(false), {
            once: true,
          })
        )
      },
    }
  )
  assert.equal((await turn).text, "Cancelled the tool")
  assert.equal(reviewSignal?.aborted, true)
  assert.deepEqual(child.responses, [])
})
