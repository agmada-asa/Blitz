/**
 * Covers moving a chat to another provider after a usage limit: which
 * providers are offered, how the old session becomes a seed, and the note the
 * new provider reads first. No runtime process or model turn is used.
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  renderTranscript,
  type Engine,
  type HistoryTurn,
  type PortableTranscript,
} from "agent-engines"

import { handoffCandidates, providerLabel } from "../lib/provider-handoff.ts"
import {
  fitTranscript,
  handoffPrompt,
  readHandoffTranscript,
} from "../lib/server/provider-handoff.ts"

/** Builds one exported turn with a question, reasoning, a tool call and an answer. */
function turn(id: string, question: string, answer = "Answer"): HistoryTurn {
  return {
    id,
    status: "completed",
    entries: [
      { kind: "message", role: "user", text: question },
      { kind: "reasoning", text: "Private reasoning" },
      {
        kind: "tool",
        tool: { kind: "builtin", name: "read", input: { path: "notes.md" } },
        output: "Notes",
      },
      { kind: "message", role: "assistant", text: answer },
    ],
  }
}

test("only other providers that are installed and signed in are offered", () => {
  assert.deepEqual(
    handoffCandidates("codex", [
      { providerId: "codex", available: true, authenticated: true },
      { providerId: "claude-code", available: true, authenticated: true },
      { providerId: "opencode", available: true, authenticated: null },
    ]),
    ["claude-code"]
  )
  assert.deepEqual(
    handoffCandidates("claude-code", [
      { providerId: "codex", available: false, authenticated: true },
      { providerId: "opencode", available: true, authenticated: true },
    ]),
    ["opencode"]
  )
  assert.equal(providerLabel("claude-code"), "Claude Code")
})

test("a seed drops reasoning, shortens long messages and keeps the newest turns", () => {
  const transcript: PortableTranscript = {
    provider: "codex",
    threadId: "thread",
    turns: [
      turn("1", "Old question"),
      turn("2", `Sources ${"x".repeat(20_000)}`),
      turn("3", "Newest question"),
    ],
  }
  const whole = fitTranscript(transcript)
  assert.equal(whole.turns.length, 3)
  assert.ok(
    whole.turns.every((kept) =>
      kept.entries.every((entry) => entry.kind !== "reasoning")
    )
  )
  const long = whole.turns[1]!.entries[0]!
  assert.ok(long.kind === "message" && long.text.length <= 12_000)
  // Tool calls are what the seed carries over Blitz's own replay.
  assert.match(renderTranscript(whole), /\[tool read\]/)

  const tight = fitTranscript(transcript, 200)
  assert.deepEqual(
    tight.turns.map((kept) => kept.id),
    ["3"]
  )
})

/** A reader engine that returns one saved session, or fails. */
function reader(history: HistoryTurn[] | Error) {
  const calls: string[] = []
  let closed = false
  const engine = {
    readThread: async (id: string, options: { cwd: string }) => {
      calls.push(`${id}@${options.cwd}`)
      if (history instanceof Error) throw history
      return { id, provider: "codex", cwd: options.cwd, turns: history }
    },
    close: async () => {
      closed = true
    },
  } as unknown as Engine
  return { engine, calls, closed: () => closed }
}

test("the old session is read back and closed, and any failure falls back to replay", async () => {
  const ok = reader([turn("1", "Question")])
  const seed = await readHandoffTranscript(
    { fromProviderId: "codex", fromSessionId: "thread-1" },
    "/tmp/blitz-handoff",
    () => ok.engine
  )
  assert.equal(seed?.threadId, "thread-1")
  assert.equal(seed?.turns.length, 1)
  assert.deepEqual(ok.calls, ["thread-1@/tmp/blitz-handoff"])
  assert.equal(ok.closed(), true)

  const failing = reader(new Error("gone"))
  const warn = console.warn
  console.warn = () => undefined
  try {
    assert.equal(
      await readHandoffTranscript(
        { fromProviderId: "codex", fromSessionId: "thread-1" },
        "/tmp/blitz-handoff",
        () => failing.engine
      ),
      undefined
    )
  } finally {
    console.warn = warn
  }
  assert.equal(failing.closed(), true)

  const empty = reader([])
  assert.equal(
    await readHandoffTranscript(
      { fromProviderId: "codex", fromSessionId: "thread-1" },
      "/tmp/blitz-handoff",
      () => empty.engine
    ),
    undefined
  )
  assert.equal(
    await readHandoffTranscript({ fromProviderId: "codex" }, "/tmp/blitz-handoff"),
    undefined
  )
})

test("the first prompt on the new provider says who stopped and where", () => {
  const partial = handoffPrompt("Continue.", "Codex", "the occasional copy costs")
  assert.match(partial, /^The earlier conversation was with Codex/)
  assert.match(partial, /<stopped_reply>\nthe occasional copy costs\n<\/stopped_reply>/)
  assert.ok(partial.endsWith("\n\nContinue."))
  assert.match(handoffPrompt("Continue.", "Codex", " "), /before it could answer/)
})
