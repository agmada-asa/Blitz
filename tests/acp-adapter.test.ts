/** Covers ACP wire details that are easy to regress while changing provider adapters. */
import { EventEmitter } from "node:events"
import assert from "node:assert/strict"
import test from "node:test"

import {
  extractAntigravityUserInputQuestion,
  makeAntigravityUserInputResponse,
  runAcpTextTurn,
  type AcpChildProcess,
} from "../lib/server/providers/acp.ts"

test("normalizes Antigravity interaction permission requests and exact answers", () => {
  const params = {
    sessionId: "session-1",
    toolCall: { toolCallId: "interaction_1", title: "Which environment?" },
    options: [
      { optionId: "dev", kind: "allow_once", name: "Development" },
      { optionId: "prod", kind: "allow_once", name: "Production" },
    ],
  }
  assert.deepEqual(extractAntigravityUserInputQuestion(params)?.options[0], {
    value: "dev",
    label: "Development",
    description: "Development",
  })
  assert.deepEqual(
    makeAntigravityUserInputResponse(params, { interaction_1: "prod" }),
    {
      outcome: { outcome: "selected", optionId: "prod" },
    }
  )
  assert.equal(
    makeAntigravityUserInputResponse(params, { interaction_1: "unknown" }),
    undefined
  )
})

/** Minimal ACP peer used to inspect requests without starting a provider binary. */
class AcpFixture extends EventEmitter implements AcpChildProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly writes: Record<string, unknown>[] = []
  stallPrompt = false
  permissionOnPrompt = false
  permissionResponse?: Record<string, unknown>
  pendingPromptId?: string | number
  readonly stdin = {
    write: (chunk: string): boolean => {
      const message = JSON.parse(chunk) as Record<string, unknown>
      this.writes.push(message)
      queueMicrotask(() => this.respond(message))
      return true
    },
    end: (): void => undefined,
    on: (): void => undefined,
  }

  /** Responds to the subset of ACP requests needed by these tests. */
  private respond(message: Record<string, unknown>): void {
    const id = message.id
    const method = message.method
    if (method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: {} },
          },
          authMethods: [],
        },
      })
      return
    }
    if (method === "session/new") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: "session-1",
          configOptions: [
            {
              id: "model",
              type: "select",
              options: [{ value: "provider/model-high", name: "High" }],
            },
          ],
        },
      })
      return
    }
    if (
      method === "session/set_config_option" ||
      method === "session/set_mode"
    ) {
      this.send({ jsonrpc: "2.0", id, result: {} })
      return
    }
    if (method === "session/prompt") {
      this.pendingPromptId = id as string | number
      if (this.stallPrompt) return
      if (this.permissionOnPrompt) {
        this.send({
          jsonrpc: "2.0",
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId: "session-1",
            toolCall: { toolCallId: "tool-1", title: "Run command" },
            options: [
              { optionId: "once", kind: "allow_once", name: "Allow once" },
            ],
          },
        })
        return
      }
      this.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" },
          },
        },
      })
      this.send({ jsonrpc: "2.0", id, result: {} })
    }
    if (method === undefined && id === "permission-1") {
      this.permissionResponse = message.result as Record<string, unknown>
      this.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "denied" },
          },
        },
      })
      this.send({
        jsonrpc: "2.0",
        id: this.pendingPromptId,
        result: {},
      })
    }
  }

  /** Writes one newline-delimited response into the client stream. */
  private send(message: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`))
  }

  /** Records process shutdown for the ACP adapter cleanup path. */
  kill(): boolean {
    return true
  }
}

/** Runs one ACP turn against a fixture process. */
function runFixture(
  child: AcpFixture,
  model = "provider/model-high",
  attachments?: NonNullable<
    Parameters<typeof runAcpTextTurn>[0]["attachments"]
  >,
  signal?: AbortSignal,
  developerInstructions?: string
) {
  return runAcpTextTurn(
    {
      selection: { providerId: "antigravity", model },
      workspaceDirectory: "/tmp/blitz-acp-test",
      prompt: "hello",
      ...(signal ? { signal } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(attachments ? { attachments } : {}),
    },
    {
      command: { executable: "fixture", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
    }
  )
}

test("ACP sends application instructions as a bounded context prefix", async () => {
  const child = new AcpFixture()
  await runFixture(
    child,
    "provider/model-high",
    undefined,
    undefined,
    "Use the study app context."
  )
  const prompt = child.writes.find(
    (message) => message.method === "session/prompt"
  )
  const blocks = (prompt?.params as { prompt?: Array<{ text?: string }> })
    ?.prompt
  assert.match(blocks?.[0]?.text ?? "", /<blitz_application_context>/)
  assert.match(blocks?.[0]?.text ?? "", /Use the study app context\./)
})

test("ACP never policy denies native permission without invoking the UI handler", async () => {
  const child = new AcpFixture()
  child.permissionOnPrompt = true
  let calls = 0
  await runAcpTextTurn(
    {
      selection: { providerId: "antigravity", model: "provider/model-high" },
      workspaceDirectory: "/tmp/blitz-acp-test",
      prompt: "hello",
      approvalPolicy: "never",
    },
    {
      command: { executable: "fixture", args: [] },
      providerInstanceId: "local",
      spawnProcess: () => child,
      approvalHandler: async () => {
        calls += 1
        return true
      },
    }
  )
  assert.equal(calls, 0)
  assert.deepEqual(child.permissionResponse, {
    outcome: { outcome: "cancelled" },
  })
})

test("ACP emits a JSON-RPC cancellation notification", async () => {
  const child = new AcpFixture()
  child.stallPrompt = true
  const controller = new AbortController()
  const result = runFixture(
    child,
    "provider/model-high",
    undefined,
    controller.signal
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(result)
  const cancel = child.writes.find(
    (message) => message.method === "session/cancel"
  )
  assert.equal(cancel?.jsonrpc, "2.0")
})

test("ACP rejects a model that is not advertised by session config", async () => {
  const child = new AcpFixture()
  await assert.rejects(runFixture(child, "provider/unknown"), /not advertised/)
})

test("ACP sends image attachments only after image capability negotiation", async () => {
  const child = new AcpFixture()
  await runFixture(child, "provider/model-high", [
    {
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
      name: "hello.png",
    },
  ])
  const prompt = child.writes.find(
    (message) => message.method === "session/prompt"
  )
  const blocks = (prompt?.params as { prompt?: unknown[] })?.prompt
  assert.equal((blocks?.[1] as { type?: string })?.type, "image")
})
