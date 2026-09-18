/** Verifies bounded provider tool lifecycle normalization for chat activity. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeProviderActivity } from "../lib/provider-activity.ts"

test("normalizes Codex started and completed items with native correlation", () => {
  const started = normalizeProviderActivity({
    type: "activity",
    method: "item/started",
    params: {
      item: { id: "item-1", type: "commandExecution", command: "ls -la" },
    },
  })
  const completed = normalizeProviderActivity({
    type: "activity",
    method: "item/completed",
    params: {
      item: {
        id: "item-1",
        type: "commandExecution",
        status: "completed",
        aggregatedOutput: "private output that must not be retained",
      },
    },
  })
  assert.equal(started?.id, "item-1")
  assert.equal(started?.type, "tool")
  assert.equal(started?.title, "Run command")
  assert.equal(started?.status, "running")
  assert.equal(started?.detail, "ls -la")
  assert.equal(typeof started?.startedAt, "number")

  assert.equal(completed?.id, "item-1")
  assert.equal(completed?.type, "tool")
  assert.equal(completed?.title, "Run command")
  assert.equal(completed?.status, "completed")
  assert.equal(typeof completed?.completedAt, "number")

  // Retains detail and startedAt from previous started item when correlated
  const correlated = normalizeProviderActivity(
    {
      type: "activity",
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          type: "commandExecution",
          status: "completed",
        },
      },
    },
    started ? [started] : []
  )
  assert.equal(correlated?.detail, "ls -la")
  assert.equal(correlated?.startedAt, started?.startedAt)
})

test("extracts details for web search and file changes", () => {
  const search = normalizeProviderActivity({
    type: "activity",
    method: "item/started",
    params: {
      item: {
        id: "search-1",
        type: "webSearch",
        query: "nextjs app router",
      },
    },
  })
  assert.equal(search?.title, "Search web")
  assert.equal(search?.detail, "nextjs app router")

  const fileEdit = normalizeProviderActivity({
    type: "activity",
    method: "item/started",
    params: {
      item: {
        id: "edit-1",
        type: "fileChange",
        changes: [{ path: "app/page.tsx" }],
      },
    },
  })
  assert.equal(fileEdit?.title, "Edit file")
  assert.equal(fileEdit?.detail, "app/page.tsx")
})

test("normalizes Claude tool use and result frames", () => {
  assert.equal(
    normalizeProviderActivity({
      type: "activity",
      method: "claude/tool_use",
      params: {
        block: {
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: { command: "pwd" },
        },
      },
    })?.status,
    "running"
  )
  assert.equal(
    normalizeProviderActivity({
      type: "activity",
      method: "claude/tool_result",
      params: {
        block: { type: "tool_result", tool_use_id: "tool-2", is_error: true },
      },
    })?.status,
    "failed"
  )
})

test("normalizes ACP tool call updates and bounds metadata", () => {
  const result = normalizeProviderActivity({
    type: "activity",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCall: {
          toolCallId: "acp-1",
          title: "A very long title ".repeat(20),
          status: "completed",
          rawOutput: "do not retain this output",
        },
      },
    },
  })
  assert.equal(result?.status, "completed")
  assert.equal(result?.title.length, 120)
  assert.equal(result?.detail, undefined)
})

test("ignores unknown activity and raw oversized payloads", () => {
  assert.equal(
    normalizeProviderActivity({
      type: "activity",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk" } },
    }),
    undefined
  )
  assert.equal(
    normalizeProviderActivity({
      type: "activity",
      method: "unknown",
      params: {},
    }),
    undefined
  )
})

/** Preserves a tool's title when ACP streams a status-only completion frame. */
test("ACP partial completion retains correlated tool identity", () => {
  const started = normalizeProviderActivity({
    type: "activity",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read notes",
        status: "in_progress",
      },
    },
  })!
  const completed = normalizeProviderActivity(
    {
      type: "activity",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        },
      },
    },
    [started]
  )
  assert.equal(completed?.title, "Read notes")
  assert.equal(completed?.status, "completed")
})
