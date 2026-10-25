/**
 * Exercises OpenCode turns end to end through the provider router and the
 * agent-engines ACP engine, against an in-memory ACP peer. No OpenCode
 * process, model turn, or network connection is used.
 */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import type { AgentRequest } from "agent-engines"

import { CardChatError, type CardChatEvent } from "../lib/server/card-chat.ts"
import { OPENCODE_AGENT_NAME } from "../lib/server/providers/opencode.ts"
import {
  runProviderTextTurn,
  type RunProviderTextTurnRequest,
} from "../lib/server/providers/run-text-turn.ts"

const WORKSPACE = "/tmp/blitz-opencode-test"

type Message = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

/**
 * Minimal ACP peer that behaves like OpenCode: modes are a config option,
 * sessions load by replaying history, and a permission request can be raised
 * during a prompt.
 */
class FakeOpenCode extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly received: Message[] = []
  spawnedWith?: { cwd: string; env: NodeJS.ProcessEnv }
  /** The agent the loaded session last used; OpenCode reports it on load. */
  storedMode = OPENCODE_AGENT_NAME
  /** Fails every prompt, as OpenCode does for a session whose agent is gone. */
  failPrompt = false
  /** Raises one permission request before answering the prompt. */
  askPermission = false
  permissionAnswer?: Record<string, unknown>
  /** The session's current model. */
  model = "opencode/big-pickle"
  private promptId?: number | string

  readonly stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as Message
        this.received.push(message)
        queueMicrotask(() => this.respond(message))
      }
      return true
    },
    end: (): void => undefined,
    on: (): void => undefined,
  }

  /** Requests the client sent with one method. */
  sent(method: string): Message[] {
    return this.received.filter((message) => message.method === method)
  }

  /** Answers the requests an OpenCode turn makes. */
  private respond(message: Message): void {
    const reply = (result: unknown) =>
      this.send({ jsonrpc: "2.0", id: message.id, result })
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {} },
          },
          authMethods: [],
          agentInfo: { name: "OpenCode", version: "1.18.21" },
        })
      case "session/new":
        return reply({
          sessionId: "session-new",
          configOptions: this.configOptions(OPENCODE_AGENT_NAME),
        })
      case "session/load":
        this.update("session-old", {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Earlier question" },
        })
        return reply({ configOptions: this.configOptions(this.storedMode) })
      case "session/set_config_option": {
        const value = String(message.params?.value)
        if (message.params?.configId === "model") this.model = value
        else this.storedMode = value
        return reply({ configOptions: this.configOptions(this.storedMode) })
      }
      case "session/close":
        return reply({})
      case "session/prompt": {
        const sessionId = String(message.params?.sessionId)
        if (this.failPrompt) {
          // OpenCode sends its command list after a reload, even when the prompt then fails.
          this.update(sessionId, {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "compact", description: "Compact" }],
          })
          return this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "Internal error" },
          })
        }
        if (this.askPermission) {
          this.promptId = message.id
          return this.send({
            jsonrpc: "2.0",
            id: "permission-1",
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "tool-1", title: "bash", kind: "execute" },
              options: [
                { optionId: "once", kind: "allow_once", name: "Allow once" },
                { optionId: "always", kind: "allow_always", name: "Always" },
                { optionId: "reject", kind: "reject_once", name: "Reject" },
              ],
            },
          })
        }
        this.answer(sessionId, message.id)
        return
      }
    }
    if (message.id === "permission-1" && message.result) {
      this.permissionAnswer = message.result
      this.answer("session-new", this.promptId)
    }
  }

  /** Streams one tool call and a reply, then ends the prompt. */
  private answer(sessionId: string, id: number | string | undefined): void {
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "read",
      kind: "read",
      status: "pending",
      rawInput: { filePath: "notes.md" },
    })
    this.update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "read-1",
      status: "completed",
    })
    this.update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OpenCode answer" },
    })
    this.send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
  }

  /** OpenCode's model and mode options, with the given mode selected. */
  private configOptions(mode: string) {
    return [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: this.model,
        options: [
          { value: "opencode/big-pickle", name: "Big Pickle" },
          { value: "opencode/other", name: "Other" },
        ],
      },
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: mode,
        options: [OPENCODE_AGENT_NAME, "build", "plan"].map((value) => ({
          value,
          name: value,
        })),
      },
    ]
  }

  /** Sends one session update notification. */
  private update(sessionId: string, update: Record<string, unknown>): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    })
  }

  /** Writes one newline-delimited message to the client. */
  private send(message: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`))
  }

  /** Ends the fake process the way a real child reports it. */
  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, null))
    return true
  }
}

/** Runs one OpenCode turn on a fake peer, collecting every event. */
async function run(
  peer: FakeOpenCode,
  request: Partial<RunProviderTextTurnRequest> = {},
  onRequest?: (request: AgentRequest, providerId: string) => Promise<void>
) {
  const events: CardChatEvent[] = []
  const result = runProviderTextTurn(
    {
      providerId: "opencode",
      workspaceDirectory: WORKSPACE,
      prompt: "Question",
      approvalPolicy: "on-request",
      ...request,
    },
    {
      onEvent: (event) => events.push(event),
      spawnOpenCode: (_command, _args, options) => {
        peer.spawnedWith = options
        return peer
      },
      ...(onRequest ? { onRequest } : {}),
    }
  )
  return { events, result }
}

/** Asserts a promise rejects with a card-chat error of the given reason. */
async function rejectsWith(promise: Promise<unknown>, reason: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof CardChatError && error.reason === reason
  )
}

test("an OpenCode turn runs in the workspace with Blitz's agent, instructions and activity", async () => {
  const peer = new FakeOpenCode()
  const { events, result } = await run(peer, {
    developerInstructions: "Cite the unit files.",
  })
  const reply = await result
  assert.equal(reply.text, "OpenCode answer")
  assert.equal(reply.threadId, "session-new")
  assert.equal(peer.spawnedWith?.cwd, WORKSPACE)
  const config = JSON.parse(peer.spawnedWith!.env.OPENCODE_CONFIG_CONTENT!)
  assert.equal(config.default_agent, OPENCODE_AGENT_NAME)
  const prompt = peer.sent("session/prompt")[0]!.params!.prompt as Array<{
    text?: string
  }>
  assert.match(
    prompt[0]!.text!,
    /^<blitz_application_context>\nCite the unit files\.[\s\S]*<\/blitz_application_context>\n\nQuestion$/
  )
  // The session already runs Blitz's agent, so no mode switch is sent.
  assert.equal(peer.sent("session/set_config_option").length, 0)
  assert.deepEqual(
    events.filter((event) => event.type === "turn-started"),
    [{ type: "turn-started", threadId: "session-new", turnId: reply.turnId }]
  )
  const activity = events.filter((event) => event.type === "activity")
  assert.equal(activity.length, 2)
  assert.equal(
    (activity[0] as { notification: { method: string } }).notification.method,
    "tool/started"
  )
})

test("an OpenCode model choice is applied through the session's model option", async () => {
  const peer = new FakeOpenCode()
  const { result } = await run(peer, { model: "opencode/other" })
  await result
  assert.deepEqual(
    peer.sent("session/set_config_option").map((message) => message.params),
    [{ sessionId: "session-new", configId: "model", value: "opencode/other" }]
  )
})

test("a resumed OpenCode session keeps Blitz's agent and reports the turn once it answers", async () => {
  const peer = new FakeOpenCode()
  const { events, result } = await run(peer, { threadId: "session-old" })
  const reply = await result
  assert.equal(reply.threadId, "session-old")
  assert.equal(peer.sent("session/load").length, 1)
  assert.equal(peer.sent("session/set_config_option").length, 0)
  assert.equal(
    events.filter((event) => event.type === "turn-started").length,
    1
  )
})

test("a resumed OpenCode session that fails before answering is a transport failure with no started turn", async () => {
  const peer = new FakeOpenCode()
  peer.storedMode = "blitz-0d6f1c2e"
  peer.failPrompt = true
  const { events, result } = await run(peer, { threadId: "session-old" })
  await rejectsWith(result, "transport")
  assert.equal(
    events.some((event) => event.type === "turn-started"),
    false
  )
})

test("an OpenCode approval reaches the chat and is allowed once", async () => {
  const peer = new FakeOpenCode()
  peer.askPermission = true
  const seen: string[] = []
  const { result } = await run(peer, {}, async (request, providerId) => {
    seen.push(`${providerId}:${request.kind}`)
    if (request.kind === "approval") await request.respond({ decision: "allow" })
  })
  await result
  assert.deepEqual(seen, ["opencode:approval"])
  assert.deepEqual(peer.permissionAnswer, {
    outcome: { outcome: "selected", optionId: "once" },
  })
})

test("OpenCode turns with approvals off refuse permission requests without asking", async () => {
  for (const request of [
    { approvalPolicy: "never" as const },
    { ephemeral: true },
    { sandbox: "read-only" as const },
  ]) {
    const peer = new FakeOpenCode()
    peer.askPermission = true
    let asked = false
    const { result } = await run(peer, request, async () => {
      asked = true
    })
    await result
    assert.equal(asked, false)
    assert.deepEqual(peer.permissionAnswer, {
      outcome: { outcome: "selected", optionId: "reject" },
    })
  }
})

test("OpenCode refuses a workspace-only sandbox and oversized instructions before starting", async () => {
  for (const request of [
    { sandbox: "workspace-write" as const },
    { developerInstructions: "x".repeat(16_001) },
  ]) {
    const peer = new FakeOpenCode()
    const { result } = await run(peer, request)
    await rejectsWith(result, "invalid-input")
    assert.equal(peer.received.length, 0)
  }
})

test("an OpenCode turn leaves out every option its ACP engine cannot take", async () => {
  const peer = new FakeOpenCode()
  let capsRead = false
  const events: CardChatEvent[] = []
  const reply = await runProviderTextTurn(
    {
      providerId: "opencode",
      workspaceDirectory: WORKSPACE,
      prompt: "Question",
      approvalPolicy: "on-request",
      // Background work and chat options that only Codex and Claude Code take.
      ephemeral: true,
      outputSchema: { type: "object", properties: {}, required: [] },
      mode: "plan",
      files: [{ path: `${WORKSPACE}/paper.pdf`, name: "paper.pdf" }],
      fork: { threadId: "session-old", throughTurnId: "turn-1" },
      compactFirst: true,
      compactedPrompt: "Restated question",
      rewindBeforeTurnId: "turn-1",
      readContextUsage: true,
    },
    {
      onEvent: (event) => events.push(event),
      backgroundLimits: async () => {
        capsRead = true
        return { maxBudgetUsd: 1 }
      },
      spawnOpenCode: (_command, _args, options) => {
        peer.spawnedWith = options
        return peer
      },
    }
  )
  assert.equal(reply.text, "OpenCode answer")
  assert.equal(reply.output, undefined)
  assert.equal(reply.contextUsage, undefined)
  assert.equal(capsRead, false)
  // A new session, not a fork, and no plan mode switch.
  assert.equal(peer.sent("session/new").length, 1)
  assert.equal(peer.sent("session/fork").length, 0)
  assert.equal(peer.sent("session/set_config_option").length, 0)
  assert.equal(
    events.some((event) => event.type === "compacted" || event.type === "rewound"),
    false
  )
  const prompt = peer.sent("session/prompt")[0]!.params!.prompt as Array<{
    type: string
    text?: string
  }>
  // The ordinary prompt, with no document attached.
  assert.deepEqual(
    prompt.map((block) => block.type),
    ["text"]
  )
  assert.match(prompt[0]!.text!, /Question$/)
})
