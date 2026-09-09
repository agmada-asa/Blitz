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
  normalizeCodexAgentRequest,
  userInputResponse,
} from "../lib/server/agent-request.ts"

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
  const spec = normalizeCodexAgentRequest({
    id: "tool-1",
    method: "item/tool/call",
    params: {
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
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            accepted: true,
            answers: { label: { answers: ["Beta"] } },
          }),
        },
      ],
      success: true,
    }
  )
})

test("normalizes an explicit Blitz approval checkpoint", () => {
  const spec = normalizeCodexAgentRequest({
    id: "tool-2",
    method: "item/tool/call",
    params: {
      tool: BLITZ_REQUEST_APPROVAL_TOOL,
      arguments: {
        title: "Create test file",
        prompt: "Create blitz-request-ui-test.txt?",
        details: "The file will contain one line.",
      },
    },
  })

  assert.ok(spec)
  assert.equal(spec.kind, "approval")
  assert.equal(spec.title, "Create test file")
  assert.deepEqual(dynamicToolResponse(spec, false), {
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ accepted: false }),
      },
    ],
    success: true,
  })
})

test("normalizes Codex questions and validates displayed answers", () => {
  const spec = normalizeCodexAgentRequest({
    id: "question-1",
    method: "item/tool/requestUserInput",
    params: {
      questions: [
        {
          id: "audience",
          header: "Audience",
          question: "Who should this study guide target?",
          options: [
            { label: "Beginners", description: "New to the topic" },
            { label: "Experts", description: "Already familiar" },
          ],
        },
      ],
    },
  })

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
})

test("normalizes MCP forms and rejects missing required values", () => {
  const spec = normalizeCodexAgentRequest({
    id: "form-1",
    method: "mcpServer/elicitation/request",
    params: {
      mode: "form",
      serverName: "Study planner",
      message: "Tell the planner how to organize this set.",
      requestedSchema: {
        type: "object",
        required: ["count", "mode"],
        properties: {
          count: { type: "integer", title: "Number of cards" },
          mode: { type: "string", enum: ["practice", "review"] },
        },
      },
    },
  })

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
})

test("only accepts HTTP URLs for URL-mode elicitation", () => {
  assert.throws(
    () =>
      normalizeCodexAgentRequest({
        id: "url-1",
        method: "mcpServer/elicitation/request",
        params: { mode: "url", url: "javascript:alert(1)" },
      }),
    /URL request has no URL/
  )
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
