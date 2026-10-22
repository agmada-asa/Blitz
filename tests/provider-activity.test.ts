/** Verifies bounded provider tool lifecycle normalization for chat activity. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeProviderActivity } from "../lib/provider-activity.ts"

/** Wraps one engine event the way `providers/engine-turn.ts` forwards it. */
function frame(method: string, params: Record<string, unknown>) {
  return { type: "activity", notification: { method, params } }
}

test("normalizes engine tool start and completion with item correlation", () => {
  const started = normalizeProviderActivity(
    frame("tool/started", {
      type: "tool.started",
      itemId: "c1",
      tool: {
        kind: "command",
        name: "shell",
        input: { command: "ls -la", cwd: "/tmp" },
      },
    })
  )!
  assert.equal(started.id, "c1")
  assert.equal(started.title, "Run command")
  assert.equal(started.detail, "ls -la")
  assert.equal(started.status, "running")
  assert.equal(typeof started.startedAt, "number")
  const completed = normalizeProviderActivity(
    frame("tool/completed", {
      type: "tool.completed",
      itemId: "c1",
      tool: { kind: "command", name: "shell", input: {} },
      output: "secret output",
      isError: true,
    }),
    [started]
  )!
  assert.equal(completed.status, "failed")
  assert.equal(completed.detail, "ls -la")
  assert.equal(completed.startedAt, started.startedAt)
  assert.equal(JSON.stringify(completed).includes("secret output"), false)
})

test("extracts details for web search, Claude tools, and file changes", () => {
  const search = normalizeProviderActivity(
    frame("tool/completed", {
      itemId: "w1",
      tool: {
        kind: "web-search",
        name: "web_search",
        input: {
          query: null,
          action: { type: "search", query: "spaced repetition" },
        },
      },
      isError: false,
    })
  )!
  assert.equal(search.title, "Search web")
  assert.equal(search.detail, "spaced repetition")
  const read = normalizeProviderActivity(
    frame("tool/started", {
      itemId: "toolu_1",
      tool: {
        kind: "builtin",
        name: "Read",
        input: { file_path: "/tmp/notes.md" },
      },
    })
  )!
  assert.equal(read.title, "Read file")
  assert.equal(read.detail, "/tmp/notes.md")
  const files = normalizeProviderActivity(
    frame("file/changed", {
      itemId: "f1",
      changes: [
        { path: "/tmp/a.md", kind: "add" },
        { path: "/tmp/b.md", kind: "update", diff: "+x" },
      ],
    })
  )!
  assert.equal(files.title, "Edit file")
  assert.equal(files.detail, "/tmp/a.md, /tmp/b.md")
  assert.equal(files.status, "completed")
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
