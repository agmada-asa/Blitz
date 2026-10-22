/** Verifies normalized ACP provider streams with in-memory processes. */

import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import test from "node:test"

import {
  inspectAcpAuthentication,
  parseAcpModelOptions,
  runAcpTextTurn,
  type AcpChildProcess,
} from "../lib/server/providers/acp.ts"

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
    { executable: "fake-opencode", args: [] },
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

/** Confirms nested ACP model choices retain native IDs and recognizable reasoning tiers. */
test("extracts models from ACP session configuration", () => {
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

/** Covers the nested model advertisement shape used by newer ACP peers. */
test("extracts models from the native models.availableModels shape", () => {
  assert.deepEqual(
    parseAcpModelOptions({
      models: {
        currentModelId: "native-high",
        availableModels: [
          { modelId: "native-low", name: "Native Low" },
          { id: "native-high", name: "Native High" },
        ],
      },
    }),
    [
      { id: "native-low", label: "Native Low", reasoningEffort: "low" },
      { id: "native-high", label: "Native High", reasoningEffort: "high" },
    ]
  )
})

/** Confirms an explicit ACP model variant is applied through its native model selector. */
test("applies an ACP model and encoded reasoning choice", async () => {
  const child = new FakeAcpProcess()
  child.sessionResult = {
    sessionId: "acp-session-1",
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        options: [{ value: "gemini-flash-high", name: "Gemini Flash (High)" }],
      },
    ],
  }
  await runAcpTextTurn(
    {
      selection: {
        providerId: "opencode",
        model: "gemini-flash-high",
        effort: "high",
      },
      workspaceDirectory: "/tmp/blitz-provider-test",
      prompt: "Answer briefly.",
      sandbox: "danger-full-access",
      webSearchMode: "live",
    },
    {
      command: { executable: "fake-opencode", args: [] },
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
  for (const approvalPolicy of ["on-request", "full-access"] as const) {
    const child = new FakeAcpProcess()
    child.capabilities = { sessionCapabilities: { resume: {} } }
    await runAcpTextTurn(
      {
        selection: { providerId: "opencode", model: "default" },
        workspaceDirectory: "/tmp/blitz-provider-test",
        prompt: "Use the current access mode.",
        session: {
          providerId: "opencode",
          providerSessionId: "acp-session-1",
        },
        approvalPolicy,
        webSearchMode: "live",
      },
      {
        command: { executable: "fake-opencode", args: [] },
        providerInstanceId: "local",
        spawnProcess: () => child,
      }
    )
    assert.equal(child.modeSelections.length, 1)
    assert.equal(child.modeSelections[0]?.sessionId, "acp-session-1")
    assert.match(child.modeSelections[0]?.modeId ?? "", /^blitz-/)
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
