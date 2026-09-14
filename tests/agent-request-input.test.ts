/** Guards persisted interaction controls against malformed provider data and conflicting identifiers. */
import assert from "node:assert/strict"
import test from "node:test"
import { parseAgentRequestInput } from "../lib/agent-request.ts"

/** Corrupt controls must fail as a whole instead of removing choices or crashing the conversation. */
test("malformed persisted request controls return a safe error", () => {
  const invalid = [
    "{",
    "null",
    "[]",
    JSON.stringify({ questions: [null] }),
    JSON.stringify({ questions: [{ id: "q", header: "Q", question: 42 }] }),
    JSON.stringify({ approvalOptions: [{ value: "yes" }] }),
    JSON.stringify({ fields: [{ id: "file", label: "Upload", type: "file" }] }),
    JSON.stringify({
      questions: [{ id: "__proto__", header: "Q", question: "Choose" }],
    }),
    JSON.stringify({
      questions: [
        { id: "q", header: "Q", question: "Choose", options: [null] },
      ],
    }),
    JSON.stringify({
      fields: Array(21).fill({ id: "x", label: "X", type: "text" }),
    }),
  ]
  for (const value of invalid) {
    const input = parseAgentRequestInput(value)
    assert.ok(input.validationError)
    assert.equal(input.questions, undefined)
    assert.equal(input.fields, undefined)
  }
})

/** IDs and display labels remain distinct so native values survive question and approval rendering. */
test("valid native choices and multiselect controls survive reload", () => {
  const original = {
    questions: [
      {
        id: "environment",
        header: "Environment",
        question: "Choose environments",
        multiSelect: true,
        options: [
          { value: "dev-1", label: "Development" },
          { value: "prod-2", label: "Production" },
        ],
      },
    ],
    approvalOptions: [
      { value: "scope-session", label: "Allow for this session" },
    ],
    fields: [
      { id: "enabled", label: "Enable", type: "boolean", defaultValue: false },
    ],
  }
  assert.deepEqual(parseAgentRequestInput(JSON.stringify(original)), original)
  assert.deepEqual(parseAgentRequestInput(), {})
})

/** Duplicate identifiers would attach an answer to the wrong control and therefore invalidate the request. */
test("duplicate response keys and option IDs are rejected", () => {
  assert.ok(
    parseAgentRequestInput(
      JSON.stringify({
        questions: [
          { id: "same", header: "A", question: "First" },
          { id: "same", header: "B", question: "Second" },
        ],
      })
    ).validationError
  )
  assert.ok(
    parseAgentRequestInput(
      JSON.stringify({
        approvalOptions: [
          { value: "same", label: "Allow once" },
          { value: "same", label: "Allow always" },
        ],
      })
    ).validationError
  )
})
