/** Verifies the native project boundary rejects malformed operations before a database call. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  parseProjectList,
  parseProjectOperation,
} from "../lib/project-contracts.ts"

test("project operations accept only bounded names and supported actions", () => {
  assert.deepEqual(
    parseProjectOperation({ action: "create", title: "  Acoustics  " }),
    { action: "create", title: "Acoustics" }
  )
  assert.deepEqual(
    parseProjectOperation({
      action: "delete",
      projectId: "abc123",
      title: "ignored",
    }),
    { action: "delete", projectId: "abc123" }
  )
  for (const input of [
    null,
    {},
    { action: "delete", projectId: "../projects" },
    { action: "rename", projectId: "abc123", title: " " },
    { action: "create", title: "x".repeat(201) },
    { action: "archive", projectId: "abc123" },
  ])
    assert.throws(() => parseProjectOperation(input))
})

test("project metadata retains empty projects and rejects malformed server fields", () => {
  assert.deepEqual(
    parseProjectList([{ id: "abc123", title: "New", createdAt: 123 }]),
    [{ id: "abc123", title: "New", createdAt: 123 }]
  )
  for (const input of [
    { projects: [] },
    [null],
    [{ id: "abc123", title: "New", createdAt: "yesterday" }],
    [{ id: "abc123", title: "New", createdAt: NaN }],
  ])
    assert.throws(() => parseProjectList(input))
})
