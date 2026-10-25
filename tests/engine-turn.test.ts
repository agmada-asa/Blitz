/**
 * Exercises Codex and Claude Code turns through the agent-engines adapter and
 * the provider router, with an in-memory engine. No runtime process, model
 * turn, subscription usage, or network connection is used.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { RuntimeModelUnavailableError, type AgentRequest } from "agent-engines"

import {
  CardChatError,
  MAX_CARD_CHAT_STREAM_TEXT_LENGTH,
  type CardChatEvent,
} from "../lib/server/card-chat.ts"
import { runEngineTurn } from "../lib/server/providers/engine-turn.ts"
import { runProviderTextTurn } from "../lib/server/providers/run-text-turn.ts"
import type { ProviderModelOption } from "../lib/server/providers/types.ts"
import { FakeEngine, type FakeTurn } from "./fixtures/fake-engine.ts"

const WORKSPACE = "/tmp/blitz-owned-workspace"

/** Runs one turn on a fake engine, collecting every event. */
async function run(
  engine: FakeEngine,
  overrides: Partial<Parameters<typeof runEngineTurn>[0]> = {},
  onRequest?: (request: AgentRequest) => Promise<void>
) {
  const events: CardChatEvent[] = []
  const result = runEngineTurn(
    {
      providerId: engine.provider === "codex" ? "codex" : "claude-code",
      engine,
      thread: { cwd: WORKSPACE },
      input: "Question",
      ...overrides,
    },
    {
      onEvent: (event) => events.push(event),
      ...(onRequest ? { onRequest } : {}),
    }
  )
  return { events, result }
}

/** Asserts a promise rejects with a card-chat error of the given reason. */
async function rejectsWith(promise: Promise<unknown>, reason: string) {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof CardChatError && error.reason === reason
  )
}

test("requires an absolute workspace and closes the engine without starting a thread", async () => {
  const engine = new FakeEngine("codex")
  const { result } = await run(engine, { thread: { cwd: "relative" } })
  await rejectsWith(result, "invalid-input")
  assert.equal(engine.started.length, 0)
  assert.equal(engine.closed, true)
})

test("a pre-aborted request starts no thread", async () => {
  const engine = new FakeEngine("codex")
  const controller = new AbortController()
  controller.abort()
  const { events, result } = await run(engine, { signal: controller.signal })
  await rejectsWith(result, "aborted")
  assert.equal(engine.started.length, 0)
  assert.deepEqual(
    events.map((event) => event.type),
    ["error"]
  )
})

test("returns IDs, streams the reply, and closes the thread and engine", async () => {
  const engine = new FakeEngine("codex")
  const { events, result } = await run(engine)
  const value = await result
  assert.equal(value.threadId, "thr_new")
  assert.equal(value.turnId, "turn_1")
  assert.equal(value.text, "A clear answer.")
  assert.deepEqual(
    events.map((event) => event.type),
    ["turn-started", "text-delta", "completed"]
  )
  assert.equal(engine.threadCloses, 1)
  assert.equal(engine.closed, true)
})

test("resumes a saved thread with the same thread options", async () => {
  const engine = new FakeEngine("claude")
  const { result } = await run(engine, {
    threadId: "thr_saved",
    thread: { cwd: WORKSPACE, model: "sonnet" },
  })
  assert.equal((await result).threadId, "thr_saved")
  assert.deepEqual(engine.resumed, [
    { id: "thr_saved", options: { cwd: WORKSPACE, model: "sonnet" } },
  ])
})

test("aborting a running turn interrupts it, emits one error, and cleans up", async () => {
  const controller = new AbortController()
  const engine = new FakeEngine("codex", (turn) => {
    turn.push({ type: "turn.started" })
    setTimeout(() => controller.abort(), 5)
  })
  const { events, result } = await run(engine, { signal: controller.signal })
  await rejectsWith(result, "aborted")
  assert.equal(engine.turns[0].interrupts, 1)
  assert.equal(events.filter((event) => event.type === "error").length, 1)
  assert.equal(engine.closed, true)
})

test("times out a running turn and interrupts it", async () => {
  const engine = new FakeEngine("claude", (turn) =>
    turn.push({ type: "turn.started" })
  )
  const { result } = await run(engine, { timeoutMs: 20 })
  await rejectsWith(result, "timeout")
  assert.equal(engine.turns[0].interrupts, 1)
})

test("a completed turn without assistant text fails", async () => {
  const engine = new FakeEngine("codex", (turn) =>
    turn.finish({ status: "completed" })
  )
  await rejectsWith((await run(engine)).result, "turn-failed")
})

test("maps usage limits, capacity, rate limits, and unknown failures to recovery reasons", async () => {
  for (const [error, reason] of [
    [{ kind: "usage-limit", message: "Usage limit reached" }, "usage-limit"],
    [
      { kind: "rate-limit", message: "Selected model is at capacity." },
      "provider-overloaded",
    ],
    [{ kind: "rate-limit", message: "Too many requests" }, "rate-limit"],
    [{ kind: "model", message: "Rerouted" }, "invalid-input"],
    [{ kind: "connection", message: "Codex exited" }, "transport"],
    [{ kind: "other", message: "Something odd" }, "turn-failed"],
    // Blitz sets no turn limits, so a limit stop is an ordinary failed turn.
    [{ kind: "limit", message: "Turn limit reached" }, "turn-failed"],
  ] as const) {
    const engine = new FakeEngine("codex", (turn) =>
      turn.finish({ status: "failed", error: { ...error } })
    )
    const { result } = await run(engine)
    await assert.rejects(result, (failure: unknown) => {
      assert.ok(failure instanceof CardChatError)
      assert.equal(failure.reason, reason)
      // The runtime's own reason stays on the cause for diagnostics.
      assert.equal(
        (failure.cause as { message?: string }).message,
        error.message
      )
      return true
    })
  }
})

test("hook, notice, goal, MCP status and realtime events add nothing to the turn", async () => {
  for (const provider of ["codex", "claude"] as const) {
    const engine = new FakeEngine(provider, (turn) => {
      turn.push({ type: "turn.started" })
      turn.push({ type: "hook.started", hookId: "h1", event: "PreToolUse" })
      turn.push({
        type: "hook.completed",
        hookId: "h1",
        event: "PreToolUse",
        status: "completed",
      })
      turn.push({ type: "notice", kind: "warning", message: "Heads up" })
      turn.push({ type: "goal.updated", goal: null })
      turn.push({ type: "mcp.status", server: "notes", status: "ready" })
      turn.push({ type: "realtime.transcript.delta", role: "user", delta: "x" })
      turn.push({ type: "prompt.suggestion", suggestion: "Next?" })
      turn.push({ type: "text.delta", itemId: "m1", delta: "Answer." })
      turn.push({ type: "text.done", itemId: "m1", text: "Answer." })
      turn.finish({ status: "completed", text: "Answer." })
    })
    const { events, result } = await run(engine)
    assert.equal((await result).text, "Answer.")
    assert.deepEqual(
      events.map((event) => event.type),
      ["turn-started", "text-delta", "completed"]
    )
  }
})

test("an interrupted turn nobody asked to stop reports an interruption", async () => {
  const engine = new FakeEngine("codex", (turn) =>
    turn.finish({ status: "interrupted" })
  )
  await rejectsWith((await run(engine)).result, "turn-interrupted")
})

test("fails when streamed assistant text exceeds the collection bound", async () => {
  const engine = new FakeEngine("claude", (turn) => {
    turn.push({ type: "turn.started" })
    turn.push({
      type: "text.delta",
      itemId: "m",
      delta: "x".repeat(MAX_CARD_CHAT_STREAM_TEXT_LENGTH + 1),
    })
  })
  await rejectsWith((await run(engine)).result, "transport")
})

test("thread start failures map to recovery reasons", async () => {
  const engine = new FakeEngine("claude")
  engine.startError = new RuntimeModelUnavailableError(
    "Claude does not offer opus with low effort."
  )
  await rejectsWith((await run(engine)).result, "invalid-input")
  const other = new FakeEngine("codex")
  other.startError = new Error("spawn failed")
  await rejectsWith((await run(other)).result, "transport")
  assert.equal(other.closed, true)
})

test("Codex progress notes and reasoning become thought; the answers are the reply", async () => {
  const engine = new FakeEngine("codex", (turn: FakeTurn) => {
    turn.push({ type: "turn.started" })
    turn.push({
      type: "text.delta",
      itemId: "c1",
      delta: "Looking at files",
      phase: "commentary",
    })
    turn.push({
      type: "text.done",
      itemId: "c1",
      text: "Looking at files",
      phase: "commentary",
    })
    turn.push({ type: "reasoning.delta", itemId: "r1", delta: "Hmm" })
    turn.push({ type: "reasoning.done", itemId: "r1", text: "Hmm" })
    turn.push({
      type: "text.delta",
      itemId: "s",
      delta: "subagent text",
      agentId: "child",
    })
    turn.push({
      type: "text.delta",
      itemId: "a1",
      delta: "First.",
      phase: "answer",
    })
    turn.push({
      type: "text.done",
      itemId: "a1",
      text: "First.",
      phase: "answer",
    })
    turn.push({
      type: "text.done",
      itemId: "a2",
      text: "Second.",
      phase: "answer",
    })
    turn.finish({ status: "completed", text: "Second." })
  })
  const { events, result } = await run(engine)
  const value = await result
  assert.equal(value.text, "First.\nSecond.")
  assert.equal(value.thought, "Looking at files\n\nHmm")
  const deltas = events.filter(
    (event): event is Extract<CardChatEvent, { delta: string }> =>
      event.type === "text-delta" || event.type === "thought-delta"
  )
  assert.deepEqual(
    deltas.map((event) => [event.type, event.delta]),
    [
      ["thought-delta", "Looking at files"],
      ["thought-delta", "Hmm"],
      ["text-delta", "First."],
    ]
  )
})

test("Claude's reply is everything it streamed", async () => {
  const engine = new FakeEngine("claude", (turn) => {
    turn.push({ type: "turn.started" })
    turn.push({ type: "text.delta", itemId: "m1", delta: "Let me check. " })
    turn.push({ type: "text.delta", itemId: "m2", delta: "The answer is 4." })
    turn.finish({ status: "completed", text: "The answer is 4." })
  })
  assert.equal(
    (await (await run(engine)).result).text,
    "Let me check. The answer is 4."
  )
})

test("tool, tool progress and file events become activity frames, subagents' included", async () => {
  const engine = new FakeEngine("codex", (turn) => {
    turn.push({
      type: "tool.started",
      itemId: "c1",
      tool: { kind: "command", name: "shell", input: { command: "ls" } },
    })
    turn.push({ type: "tool.progress", itemId: "c1", message: "Listing" })
    turn.push({
      type: "tool.completed",
      itemId: "w1",
      tool: { kind: "web-search", name: "web_search", input: { query: "x" } },
      isError: false,
      agentId: "child",
    })
    turn.push({
      type: "file.changed",
      itemId: "f1",
      changes: [{ path: "/tmp/a.md", kind: "add" }],
    })
    turn.answer("Done.")
  })
  const { events, result } = await run(engine)
  await result
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === "activity" && "notification" in event
        ? [event.notification.method]
        : []
    ),
    ["tool/started", "tool/progress", "tool/completed", "file/changed"]
  )
})

test("requests are refused without a handler and answered by one", async () => {
  const answers: unknown[] = []
  /** Builds an approval request that records its decision. */
  const approval = (id: string): AgentRequest => ({
    kind: "approval",
    id,
    action: "command",
    title: "Run ls",
    command: "ls",
    raw: { command: "ls" },
    respond: async (decision) => {
      answers.push([id, decision.decision])
    },
  })
  const script = (id: string) => (turn: FakeTurn) => {
    turn.push({ type: "request", request: approval(id) })
    setTimeout(() => turn.answer("Done."), 5)
  }
  await (
    await run(new FakeEngine("codex", script("unhandled")))
  ).result
  await (
    await run(new FakeEngine("claude", script("handled")), {}, (request) =>
      request.kind === "approval"
        ? request.respond({ decision: "allow" })
        : Promise.resolve()
    )
  ).result
  assert.deepEqual(answers, [
    ["unhandled", "deny"],
    ["handled", "allow"],
  ])
})

/** A catalogue with one default Codex model that accepts images and low effort. */
const CATALOG: readonly ProviderModelOption[] = [
  {
    id: "gpt-6-luna",
    label: "Luna",
    reasoningEfforts: ["low"],
    inputModalities: ["text", "image"],
    isDefault: true,
  },
]

/** Runs the router with a fake engine and returns the engine. */
async function route(
  provider: "codex" | "claude",
  request: Partial<Parameters<typeof runProviderTextTurn>[0]>,
  options: Partial<Parameters<typeof runProviderTextTurn>[1]> = {}
): Promise<FakeEngine> {
  const engine = new FakeEngine(provider)
  await runProviderTextTurn(
    {
      providerId: provider === "codex" ? "codex" : "claude-code",
      workspaceDirectory: WORKSPACE,
      prompt: "Question",
      ...request,
    },
    { codexModelCatalog: CATALOG, createEngine: () => engine, ...options }
  )
  return engine
}

test("forwards approval policy to new and resumed Codex threads", async () => {
  for (const threadId of [undefined, "thr_saved"]) {
    for (const approvalPolicy of [
      "never",
      "on-request",
      "untrusted",
    ] as const) {
      const engine = await route("codex", { threadId, approvalPolicy })
      const options = threadId ? engine.resumed[0].options : engine.started[0]
      assert.equal(options.codex?.approvalPolicy, approvalPolicy)
    }
  }
  const full = await route("codex", {
    approvalPolicy: "full-access",
    sandbox: "danger-full-access",
  })
  assert.equal(full.started[0].codex?.approvalPolicy, "never")
})

test("forwards Codex sandbox, instructions, search, and images through the router", async () => {
  for (const sandbox of [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const) {
    const engine = await route("codex", {
      sandbox,
      model: "gpt-6-luna",
      effort: "low",
      developerInstructions: "Follow the project rules.",
      webSearchMode: "live",
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: "aGVsbG8=",
          name: "diagram.png",
        },
      ],
      approvalPolicy:
        sandbox === "danger-full-access" ? "full-access" : "on-request",
    })
    const options = engine.started[0]
    assert.equal(options.cwd, WORKSPACE)
    assert.equal(options.model, "gpt-6-luna")
    assert.equal(options.effort, "low")
    assert.equal(options.codex?.sandbox, sandbox)
    assert.equal(options.codex?.config?.web_search, "live")
    assert.equal(
      options.codex?.config?.["sandbox_workspace_write.exclude_slash_tmp"],
      sandbox === "workspace-write" ? true : undefined
    )
    assert.match(options.instructions ?? "", /project rules/)
    assert.match(
      options.instructions ?? "",
      /Execution environment supplied by Blitz/
    )
    assert.deepEqual(engine.runs[0].input, {
      text: "Question",
      images: [{ type: "base64", mediaType: "image/png", data: "aGVsbG8=" }],
    })
  }
})

test("the chat agent's Codex policy and tools apply over the router's defaults", async () => {
  const engine = await route(
    "codex",
    { sandbox: "read-only", approvalPolicy: "on-request" },
    {
      codex: {
        thread: {
          approvalPolicy: "never",
          sandbox: "workspace-write",
          approvalsReviewer: "user",
          dynamicTools: [
            {
              name: "blitz_request_user_input",
              description: "Ask",
              inputSchema: {},
            },
          ],
          config: { web_search: "live" },
        },
      },
    }
  )
  const codex = engine.started[0].codex!
  assert.equal(codex.approvalPolicy, "never")
  assert.equal(codex.sandbox, "workspace-write")
  assert.equal(codex.approvalsReviewer, "user")
  assert.equal(codex.dynamicTools?.[0].name, "blitz_request_user_input")
  assert.equal(codex.config?.web_search, "live")
  // The workspace-only write rules follow the overridden sandbox.
  assert.equal(codex.config?.["sandbox_workspace_write.network_access"], false)
})

test("Claude background generation runs isolated, with no tools or user setup", async () => {
  const engine = await route("claude", {
    ephemeral: true,
    webSearchMode: "disabled",
    sandbox: "read-only",
    approvalPolicy: "never",
  })
  const options = engine.started[0]
  assert.equal(options.access, undefined)
  assert.deepEqual(options.claude?.settingSources, [])
  assert.deepEqual(options.claude?.tools, [])
  assert.deepEqual(options.claude?.disallowedTools, ["*"])
  assert.equal(options.claude?.strictMcpConfig, true)
  assert.equal(options.claude?.permissionMode, "dontAsk")
  assert.deepEqual(options.claude?.extra, {
    settings: { disableAllHooks: true },
    includeHookEvents: false,
    extraArgs: { "safe-mode": null, restricted: null },
    persistSession: false,
  })
})

test("Claude chat turns map access policies onto permission modes", async () => {
  for (const [request, access, permissionMode] of [
    [{ approvalPolicy: "full-access" }, "full", undefined],
    [
      { approvalPolicy: "on-request", sandbox: "read-only" },
      "read-only",
      undefined,
    ],
    [{ approvalPolicy: "never" }, undefined, "dontAsk"],
    [{ approvalPolicy: "on-request" }, "ask", undefined],
  ] as const) {
    const engine = await route("claude", request)
    const options = engine.started[0]
    assert.equal(options.access, access)
    assert.equal(options.claude?.permissionMode, permissionMode)
    assert.deepEqual(options.claude?.settingSources, ["user"])
    assert.deepEqual(options.claude?.extra, {
      settings: { disableAllHooks: true },
      includeHookEvents: false,
    })
  }
})

test("Claude normalizes saved aliases, checks effort, and rejects Codex-only policies", async () => {
  const engine = await route("claude", {
    model: "claude-sonnet",
    effort: "high",
    approvalPolicy: "on-request",
  })
  assert.equal(engine.started[0].model, "sonnet")
  assert.equal(engine.started[0].effort, "high")
  const haiku = await route("claude", {
    model: "haiku",
    effort: "default",
    approvalPolicy: "on-request",
  })
  assert.equal(haiku.started[0].effort, undefined)
  await rejectsWith(
    route("claude", { model: "haiku", effort: "high" }),
    "invalid-input"
  )
  await rejectsWith(
    route("claude", { approvalPolicy: "untrusted" }),
    "invalid-input"
  )
  await rejectsWith(
    route("claude", {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    }),
    "invalid-input"
  )
})

test("a reply schema reaches Codex and Claude threads, and Claude keeps only its StructuredOutput tool", async () => {
  const schema = { type: "object", properties: {}, required: [], additionalProperties: false }
  const background = {
    ephemeral: true,
    webSearchMode: "disabled",
    sandbox: "read-only",
    approvalPolicy: "never",
    outputSchema: schema,
  } as const
  const codex = await route("codex", background)
  assert.deepEqual(codex.started[0].outputSchema, schema)
  const claude = await route("claude", background)
  const options = claude.started[0]
  assert.deepEqual(options.outputSchema, schema)
  assert.deepEqual(options.claude?.tools, [])
  assert.deepEqual(options.claude?.allowedTools, ["StructuredOutput"])
  assert.equal(options.claude?.disallowedTools, undefined)
  assert.equal(options.claude?.permissionMode, "dontAsk")
})

test("a schema reply that arrives only as parsed output becomes the text and is returned", async () => {
  const output = { grades: [{ id: "q1", marks: 2, feedback: "Good." }] }
  const engine = new FakeEngine("claude", (turn) => {
    turn.push({ type: "turn.started" })
    turn.finish({ status: "completed", text: "", output })
  })
  const { result } = await run(engine)
  const value = await result
  assert.deepEqual(value.output, output)
  assert.equal(value.text, JSON.stringify(output))
})
