/**
 * Exercises Antigravity turns end to end through the provider router and the
 * agent-engines ACP engine, against an in-memory peer shaped like `agy acp`.
 * No Antigravity process, model turn, or network connection is used.
 */

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import type { AgentRequest } from "agent-engines"

import { normalizeAgentRequest } from "../lib/server/agent-request.ts"
import { CardChatError, type CardChatEvent } from "../lib/server/card-chat.ts"
import { acpAccess, isAcpProvider } from "../lib/server/providers/acp-providers.ts"
import {
  runProviderTextTurn,
  type RunProviderTextTurnRequest,
} from "../lib/server/providers/run-text-turn.ts"
import {
  checkAntigravityVersion,
  antigravityVersionGuidance,
} from "../lib/server/providers/runtime-compat.ts"

const WORKSPACE = "/tmp/blitz-antigravity-test"

type Message = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

/**
 * Minimal ACP peer that behaves like `agy acp` 1.5.9: a model and a mode
 * config option, modes named `default`, `accept-edits`, `auto` and `plan`,
 * and a permission request raised during a prompt when asked.
 */
class FakeAntigravity extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly received: Message[] = []
  spawnedWith?: { command: string; args: readonly string[]; cwd: string }
  /** The mode the CLI was last left in. */
  mode = "default"
  model = "gemini-3.8-flash"
  askPermission = false
  /** Ends the turn with no reply once a permission is rejected, as `agy acp` does. */
  silentAfterRejection = false
  permissionAnswer?: Record<string, unknown>
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

  /** Answers the requests an Antigravity turn makes. */
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
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
        })
      case "session/new":
        return reply({ sessionId: "session-new", configOptions: this.configOptions() })
      case "session/set_config_option": {
        const value = String(message.params?.value)
        if (message.params?.configId === "model") this.model = value
        else this.mode = value
        return reply({ configOptions: this.configOptions() })
      }
      case "session/close":
        return reply({})
      case "session/prompt": {
        if (this.askPermission) {
          this.promptId = message.id
          return this.send({
            jsonrpc: "2.0",
            id: "permission-1",
            method: "session/request_permission",
            params: {
              sessionId: "session-new",
              toolCall: { toolCallId: "tool-1", title: "Run command", kind: "execute" },
              options: [
                { optionId: "once", kind: "allow_once", name: "Allow once" },
                { optionId: "always", kind: "allow_always", name: "Always allow" },
                { optionId: "reject", kind: "reject_once", name: "Reject" },
              ],
            },
          })
        }
        return this.answer(message.id)
      }
    }
    if (message.id === "permission-1" && message.result) {
      this.permissionAnswer = message.result
      const rejected =
        (message.result.outcome as { optionId?: string } | undefined)
          ?.optionId === "reject"
      if (rejected && this.silentAfterRejection)
        return this.send({
          jsonrpc: "2.0",
          id: this.promptId,
          result: { stopReason: "end_turn" },
        })
      this.answer(this.promptId)
    }
  }

  /** Streams a reply, then ends the prompt. */
  private answer(id: number | string | undefined): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-new",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Antigravity answer" },
        },
      },
    })
    this.send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
  }

  /** Antigravity's model and mode options. */
  private configOptions() {
    return [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: this.model,
        options: ["gemini-3.8-flash", "claude-sonnet-4-6"].map((value) => ({
          value,
          name: value,
        })),
      },
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: this.mode,
        options: ["default", "accept-edits", "auto", "plan"].map((value) => ({
          value,
          name: value,
        })),
      },
    ]
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

/** Runs one Antigravity turn on a fake peer, collecting every event. */
function run(
  peer: FakeAntigravity,
  request: Partial<RunProviderTextTurnRequest> = {},
  onRequest?: (request: AgentRequest, providerId: string) => Promise<void>
) {
  const events: CardChatEvent[] = []
  const result = runProviderTextTurn(
    {
      providerId: "antigravity",
      workspaceDirectory: WORKSPACE,
      prompt: "Question",
      approvalPolicy: "on-request",
      ...request,
    },
    {
      onEvent: (event) => events.push(event),
      spawnOpenCode: (command, args, options) => {
        peer.spawnedWith = { command, args, cwd: options.cwd }
        return peer
      },
      ...(onRequest ? { onRequest } : {}),
    }
  )
  return { events, result }
}

test("Antigravity runs on the ACP engine with Blitz's access mapping", () => {
  assert.equal(isAcpProvider("antigravity"), true)
  assert.equal(isAcpProvider("codex"), false)
  assert.equal(acpAccess({ approvalPolicy: "full-access" }), "full")
  assert.equal(acpAccess({ approvalPolicy: "on-request" }), "ask")
  assert.equal(acpAccess({ approvalPolicy: "never" }), "read-only")
  assert.equal(acpAccess({ ephemeral: true, approvalPolicy: "full-access" }), "read-only")
})

test("the Antigravity version gate needs the CLI with its own ACP server", () => {
  assert.equal(checkAntigravityVersion("1.5.9").supported, true)
  assert.equal(checkAntigravityVersion("2.0.0").supported, true)
  assert.equal(checkAntigravityVersion("1.4.2").supported, false)
  assert.equal(
    antigravityVersionGuidance(),
    "Update Antigravity to version 1.5.0 or newer for its built-in ACP server."
  )
})

test("an Antigravity chat turn starts `agy acp` in the workspace with Blitz's instructions", async () => {
  const peer = new FakeAntigravity()
  const { result } = run(peer, { developerInstructions: "Cite the unit files." })
  const reply = await result
  assert.equal(reply.text, "Antigravity answer")
  assert.equal(peer.spawnedWith?.cwd, WORKSPACE)
  assert.deepEqual(peer.spawnedWith?.args, ["acp"])
  const prompt = peer.sent("session/prompt")[0]!.params!.prompt as Array<{
    text?: string
  }>
  assert.match(
    prompt[0]!.text!,
    /^<blitz_application_context>\nCite the unit files\.[\s\S]*<\/blitz_application_context>\n\nQuestion$/
  )
})

test("an Antigravity model choice is applied and the session keeps the mode it opened in", async () => {
  const peer = new FakeAntigravity()
  const { result } = run(peer, { model: "claude-sonnet-4-6" })
  await result
  assert.equal(peer.model, "claude-sonnet-4-6")
  assert.equal(peer.mode, "default")
  assert.deepEqual(
    peer.sent("session/set_config_option").map((message) => message.params?.configId),
    ["model"]
  )
})

test("restricted Antigravity turns run sandboxed and refuse permission requests unseen", async () => {
  for (const request of [
    { approvalPolicy: "never" as const },
    { ephemeral: true },
    { sandbox: "read-only" as const },
  ]) {
    const peer = new FakeAntigravity()
    peer.askPermission = true
    let asked = false
    const { result } = run(peer, request, async () => {
      asked = true
    })
    await result
    assert.equal(asked, false)
    assert.deepEqual(peer.spawnedWith?.args, ["acp", "--sandbox"])
    assert.deepEqual(peer.permissionAnswer, {
      outcome: { outcome: "selected", optionId: "reject" },
    })
  }
})

test("an Antigravity turn that ends silently after a declined approval is stopped, not failed", async () => {
  const peer = new FakeAntigravity()
  peer.askPermission = true
  peer.silentAfterRejection = true
  const { result } = run(peer, {}, async (request) => {
    if (request.kind === "approval") await request.respond({ decision: "deny" })
  })
  await assert.rejects(
    result,
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "turn-interrupted"
  )
})

test("an Antigravity approval reaches the chat, is allowed once, and offers no lasting grant", async () => {
  const peer = new FakeAntigravity()
  peer.askPermission = true
  const seen: string[] = []
  const { result } = run(peer, {}, async (request, providerId) => {
    seen.push(`${providerId}:${request.kind}`)
    if (request.kind !== "approval") return
    // Antigravity keeps allow-always in its own settings, so Blitz never offers it.
    const spec = normalizeAgentRequest(request, "antigravity")
    assert.equal(spec?.input, undefined)
    await request.respond({ decision: "allow" })
  })
  await result
  assert.deepEqual(seen, ["antigravity:approval"])
  assert.deepEqual(peer.permissionAnswer, {
    outcome: { outcome: "selected", optionId: "once" },
  })
})
