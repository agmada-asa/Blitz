/** Verifies normalization and response validation for composer agent requests. */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BLITZ_REQUEST_APPROVAL_TOOL,
  BLITZ_REQUEST_USER_INPUT_TOOL,
  codexAgentRequestTools,
  dynamicToolResponse,
  genericApprovalRequest,
  mcpElicitationResponse,
  answerAgentRequest,
  normalizeAgentRequest,
  normalizeDynamicToolCall,
  refuseAgentRequest,
  userInputResponse,
} from "../lib/server/agent-request.ts"
import type { AgentRequest } from "agent-engines"

/** Builds an engine request whose `respond` records the answer it was given. */
function recorded<T extends AgentRequest>(
  request: Omit<T, "respond">
): { request: T; answers: unknown[] } {
  const answers: unknown[] = []
  return {
    request: {
      ...request,
      respond: async (answer: unknown) => {
        answers.push(answer)
      },
    } as unknown as T,
    answers,
  }
}

test("defines Blitz question and approval tools for ordinary Codex chats", () => {
  const tools = codexAgentRequestTools()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [BLITZ_REQUEST_USER_INPUT_TOOL, BLITZ_REQUEST_APPROVAL_TOOL]
  )
  assert.equal(
    tools.every((tool) => tool.type === "function"),
    true
  )
})

test("normalizes a Blitz dynamic question and returns its selected answer", () => {
  const spec = normalizeDynamicToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: BLITZ_REQUEST_USER_INPUT_TOOL,
    arguments: {
        questions: [
          {
            id: "label",
            header: "Label",
            question: "Which label should I use for the test?",
            options: [{ label: "Alpha" }, { label: "Beta" }],
          },
        ],
    },
  })

  assert.ok(spec)
  assert.equal(spec.kind, "question")
  assert.deepEqual(
    dynamicToolResponse(
      spec,
      true,
      JSON.stringify({ answers: { label: { answers: ["Beta"] } } })
    ),
    {
      text: JSON.stringify({
        accepted: true,
        answers: { label: { answers: ["Beta"] } },
      }),
      success: true,
    }
  )
})

test("normalizes an explicit Blitz approval checkpoint", () => {
  const spec = normalizeDynamicToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-2",
    namespace: null,
    tool: BLITZ_REQUEST_APPROVAL_TOOL,
    arguments: {
      title: "Create test file",
      prompt: "Create blitz-request-ui-test.txt?",
      details: "The file will contain one line.",
    },
  })

  assert.ok(spec)
  assert.equal(spec.kind, "approval")
  assert.equal(spec.title, "Create test file")
  assert.deepEqual(dynamicToolResponse(spec, false), {
    text: JSON.stringify({ accepted: false }),
    success: true,
  })
})

test("normalizes runtime questions and validates displayed answers", async () => {
  const { request, answers } = recorded<
    Extract<AgentRequest, { kind: "question" }>
  >({
    kind: "question",
    id: "question-1",
    raw: {},
    questions: [
      {
        id: "audience",
        header: "Audience",
        question: "Who should this study guide target?",
        options: [
          { label: "Beginners", description: "New to the topic" },
          { label: "Experts", description: "Already familiar" },
        ],
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ],
  })
  const spec = normalizeAgentRequest(request, "codex")

  assert.ok(spec)
  assert.equal(spec.kind, "question")
  assert.deepEqual(spec.input?.questions?.[0]?.options, [
    { value: "Beginners", label: "Beginners", description: "New to the topic" },
    { value: "Experts", label: "Experts", description: "Already familiar" },
  ])
  assert.deepEqual(
    userInputResponse(
      spec.input,
      true,
      JSON.stringify({
        answers: { audience: { answers: ["Beginners"] } },
      })
    ),
    { answers: { audience: { answers: ["Beginners"] } } }
  )
  assert.deepEqual(
    userInputResponse(
      spec.input,
      true,
      JSON.stringify({
        answers: { audience: { answers: ["Not displayed"] } },
      })
    ),
    { answers: {} }
  )
  await answerAgentRequest(request, spec, {
    accepted: true,
    response: JSON.stringify({
      answers: { audience: { answers: ["Experts"] } },
    }),
  })
  await answerAgentRequest(request, spec, { accepted: false })
  assert.deepEqual(answers, [{ audience: ["Experts"] }, {}])
})

test("normalizes MCP forms and rejects missing required values", async () => {
  const { request, answers } = recorded<
    Extract<AgentRequest, { kind: "elicitation" }>
  >({
    kind: "elicitation",
    id: "form-1",
    raw: {},
    mode: "form",
    server: "Study planner",
    message: "Tell the planner how to organize this set.",
    schema: {
      type: "object",
      required: ["count", "mode"],
      properties: {
        count: { type: "integer", title: "Number of cards" },
        mode: { type: "string", enum: ["practice", "review"] },
      },
    },
  })
  const spec = normalizeAgentRequest(request, "claude")

  assert.ok(spec)
  assert.equal(spec.kind, "form")
  assert.deepEqual(
    mcpElicitationResponse(
      spec,
      true,
      JSON.stringify({
        action: "accept",
        content: { count: 12, mode: "practice" },
      })
    ),
    {
      action: "accept",
      content: { count: 12, mode: "practice" },
    }
  )
  assert.deepEqual(
    mcpElicitationResponse(
      spec,
      true,
      JSON.stringify({ action: "accept", content: { mode: "practice" } })
    ),
    { action: "decline" }
  )
  await answerAgentRequest(request, spec, {
    accepted: true,
    response: JSON.stringify({ content: { count: 3, mode: "review" } }),
  })
  await answerAgentRequest(request, spec, { accepted: false })
  assert.deepEqual(answers, [
    { action: "accept", content: { count: 3, mode: "review" } },
    { action: "cancel" },
  ])
})

test("only accepts HTTP URLs for URL-mode elicitation", () => {
  const { request } = recorded<Extract<AgentRequest, { kind: "elicitation" }>>({
    kind: "elicitation",
    id: "url-1",
    raw: {},
    mode: "url",
    server: "github",
    message: "Sign in",
    url: "javascript:alert(1)",
  })
  assert.throws(() => normalizeAgentRequest(request, "codex"), /URL request has no URL/)
})

/** Builds a command or file approval that records its decision. */
function approval(
  overrides: Partial<Extract<AgentRequest, { kind: "approval" }>> = {}
) {
  return recorded<Extract<AgentRequest, { kind: "approval" }>>({
    kind: "approval",
    id: "approval-1",
    action: "command",
    title: "Run rm",
    command: "rm -rf build",
    raw: { command: "rm -rf build", cwd: "/repo" },
    ...overrides,
  })
}

test("denied approvals never grant an operation or a session exception", async () => {
  const { request, answers } = approval()
  const spec = normalizeAgentRequest(request, "codex")!
  assert.equal(spec.title, "Blitz wants to run a command")
  assert.deepEqual(
    spec.input?.approvalOptions?.map((option) => option.value),
    ["accept", "acceptForSession"]
  )
  await answerAgentRequest(request, spec, {
    accepted: false,
    response: JSON.stringify({ optionId: "acceptForSession" }),
  })
  await answerAgentRequest(request, spec, {
    accepted: true,
    response: JSON.stringify({ optionId: "acceptForSession" }),
  })
  await answerAgentRequest(request, spec, { accepted: true })
  assert.deepEqual(answers, [
    { decision: "deny" },
    { decision: "allow-session" },
    { decision: "allow" },
  ])
})

test("Claude approvals are once only, so no grant is written to its settings", async () => {
  const { request, answers } = approval({
    raw: { toolName: "Bash", input: { command: "rm -rf build" } },
  })
  const spec = normalizeAgentRequest(request, "claude")!
  assert.equal(spec.input?.approvalOptions, undefined)
  // The command is shown even though Claude nests it in the tool input.
  assert.match(spec.details, /"command": "rm -rf build"/)
  await answerAgentRequest(request, spec, {
    accepted: true,
    response: JSON.stringify({ optionId: "acceptForSession" }),
  })
  assert.deepEqual(answers, [{ decision: "allow" }])
})

test("file approvals show the proposed diff, and Codex ones without it are refused unseen", async () => {
  const { request } = approval({
    action: "file-change",
    command: undefined,
    changes: [{ path: "/repo/notes.md", kind: "update", diff: "-a\n+b" }],
    raw: { itemId: "f1" },
  })
  const spec = normalizeAgentRequest(request, "codex")!
  assert.equal(spec.title, "Blitz wants to change files")
  assert.match(spec.details, /proposedChange/)
  assert.match(spec.details, /notes\.md/)
  const blind = approval({ action: "file-change", command: undefined, raw: { itemId: "f2" } })
  assert.equal(normalizeAgentRequest(blind.request, "codex"), undefined)
  await refuseAgentRequest(blind.request)
  assert.deepEqual(blind.answers, [{ decision: "deny" }])
})

test("review details reject oversized requests", () => {
  const { request } = approval({ raw: { command: "x".repeat(25_000) } })
  assert.throws(() => normalizeAgentRequest(request, "codex"), /too large/)
})

test("Claude multi-select questions keep every selected answer", async () => {
  const { request, answers } = recorded<
    Extract<AgentRequest, { kind: "question" }>
  >({
    kind: "question",
    id: "q",
    raw: {},
    questions: [
      {
        id: "Topics?",
        header: "Topics",
        question: "Topics?",
        options: [
          { label: "Math", description: "" },
          { label: "Science", description: "" },
        ],
        multiSelect: true,
        allowOther: true,
        secret: false,
      },
    ],
  })
  const spec = normalizeAgentRequest(request, "claude")!
  await answerAgentRequest(request, spec, {
    accepted: true,
    response: JSON.stringify({
      answers: { "Topics?": { answers: ["Math", "Science"] } },
    }),
  })
  assert.deepEqual(answers, [{ "Topics?": ["Math", "Science"] }])
})

test("preserves exact native approval option IDs for the composer", () => {
  const spec = genericApprovalRequest(
    "session/request_permission",
    JSON.stringify({
      options: [
        { optionId: "allow_once_7", name: "Allow once", kind: "allow_once" },
        { optionId: "deny_7", name: "Deny", kind: "reject_once" },
      ],
    })
  )
  assert.deepEqual(spec.input?.approvalOptions, [
    { value: "allow_once_7", label: "Allow once" },
    { value: "deny_7", label: "Deny" },
  ])
})

test("extractApprovalCommand extracts clean command from various approval details payloads", async () => {
  const { extractApprovalCommand } = await import("../lib/agent-request.ts")

  // Codex commandExecution payload as captured from a real approval
  const codexDetails = JSON.stringify({
    request: {
      type: "unknown",
      command: "rm -- /Users/me/Downloads/installer.dmg",
    },
    proposedExecpolicyAmendment: [
      "rm",
      "--",
      "/Users/me/Downloads/installer.dmg",
    ],
  })
  assert.equal(
    extractApprovalCommand(codexDetails),
    "rm -- /Users/me/Downloads/installer.dmg"
  )

  // Direct command field
  assert.equal(
    extractApprovalCommand(JSON.stringify({ command: "touch coursework.md" })),
    "touch coursework.md"
  )

  // Array amendment fallback
  assert.equal(
    extractApprovalCommand(
      JSON.stringify({ proposedExecpolicyAmendment: ["git", "status"] })
    ),
    "git status"
  )

  // Non-command details returns undefined
  assert.equal(
    extractApprovalCommand(
      JSON.stringify({ permissions: { fileSystem: { write: ["/tmp"] } } })
    ),
    undefined
  )
  assert.equal(extractApprovalCommand(""), undefined)
  assert.equal(extractApprovalCommand(undefined), undefined)
})

