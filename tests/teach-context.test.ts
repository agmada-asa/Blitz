/**
 * Covers the Teach and chat context features built on agent-engines thread
 * operations: context usage and when compaction runs, which runtime notices a
 * learner sees, redoing a Teach reply, finishing a reply that ran out of room,
 * branching by fork, and the prewarmed engine pool. Engines are in-memory
 * fakes, so no runtime process or model turn is used.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTO_COMPACT_PERCENT,
  normalizeContextUsage,
  shouldCompactBeforeTurn,
} from "../lib/context-usage.ts"
import { providerThreadFeatures } from "../lib/provider-thread-features.ts"
import { CardChatError } from "../lib/server/card-chat.ts"
import {
  claimPrewarmedEngine,
  offerPrewarmedEngine,
  prewarmedEngineKey,
} from "../lib/server/providers/engine-pool.ts"
import {
  compactProviderThread,
  runProviderTextTurn,
} from "../lib/server/providers/run-text-turn.ts"
import {
  overflowContinuationMessage,
  parseWorkspaceChatRequest,
} from "../lib/server/workspace-chat.ts"
import { workspaceChatFailure } from "../lib/server/workspace-chat-failure.ts"
import {
  buildTeachPrompt,
  isTeachRedoStyle,
  TEACH_REDO_STYLES,
  teachRedoMessage,
} from "../lib/teach.ts"
import {
  addTurnNotice,
  MAX_TURN_NOTICES,
  shownTurnNotice,
  turnNoticeCopy,
} from "../lib/turn-notices.ts"
import { FakeEngine } from "./fixtures/fake-engine.ts"

const WORKSPACE = "/tmp/blitz-owned-workspace"

test("context usage keeps used categories, grouped, and works out the percentage", () => {
  assert.deepEqual(
    normalizeContextUsage({
      usedTokens: 50_000,
      maxTokens: 200_000,
      categories: [
        { name: "System prompt", tokens: 3_000, kind: "used" },
        { name: "Memory files", tokens: 1_000, kind: "used" },
        { name: "System tools", tokens: 6_000, kind: "used" },
        { name: "Messages", tokens: 40_000, kind: "used" },
        { name: "Free space", tokens: 140_000, kind: "free" },
        { name: "Autocompact buffer", tokens: 10_000, kind: "buffer" },
      ],
    }),
    {
      usedTokens: 50_000,
      maxTokens: 200_000,
      percent: 25,
      categories: [
        { label: "instructions", tokens: 4_000 },
        { label: "tools", tokens: 6_000 },
        { label: "conversation", tokens: 40_000 },
      ],
    }
  )
  // Codex reports only a total; an empty report is not saved.
  assert.deepEqual(normalizeContextUsage({ usedTokens: 1_200 }), {
    usedTokens: 1_200,
  })
  assert.equal(normalizeContextUsage({ usedTokens: 0 }), undefined)
  assert.equal(normalizeContextUsage({ usedTokens: "many" }), undefined)
})

test("compaction runs past the threshold, never twice in a row, and only where supported", () => {
  const full = { usedTokens: 170_000, maxTokens: 200_000, percent: 85 }
  assert.equal(
    shouldCompactBeforeTurn(full, { canCompact: true, restatedLastTurn: false }),
    true
  )
  assert.equal(
    shouldCompactBeforeTurn(full, { canCompact: true, restatedLastTurn: true }),
    false
  )
  assert.equal(
    shouldCompactBeforeTurn(full, { canCompact: false, restatedLastTurn: false }),
    false
  )
  assert.equal(
    shouldCompactBeforeTurn(
      { usedTokens: 10, percent: AUTO_COMPACT_PERCENT - 1 },
      { canCompact: true, restatedLastTurn: false }
    ),
    false
  )
  assert.equal(
    shouldCompactBeforeTurn(undefined, { canCompact: true, restatedLastTurn: false }),
    false
  )
})

test("only Codex and Claude Code fork, rewind, compact, report context, and prewarm", () => {
  for (const provider of ["codex", "claude-code"])
    assert.deepEqual(providerThreadFeatures(provider), {
      fork: true,
      rewind: true,
      compact: true,
      contextUsage: true,
      prewarm: true,
    })
  for (const provider of ["opencode", "unknown", undefined])
    assert.equal(Object.values(providerThreadFeatures(provider)).some(Boolean), false)
})

test("only refusals, denied tools, and safety checks reach the learner, once each", () => {
  assert.equal(shownTurnNotice("warning", "Old config"), undefined)
  assert.equal(shownTurnNotice("deprecation", "Going away"), undefined)
  const denied = shownTurnNotice("permission-denied", "  WebFetch was\nnot allowed. ", "rule")
  assert.deepEqual(denied, {
    kind: "permission-denied",
    message: "WebFetch was not allowed.",
    details: "rule",
  })
  let notices = addTurnNotice([], denied!)
  assert.equal(addTurnNotice(notices, denied!), notices)
  for (let index = 0; index < 10; index += 1)
    notices = addTurnNotice(notices, { kind: "refusal", message: `No ${index}` })
  assert.equal(notices.length, MAX_TURN_NOTICES)
  assert.match(turnNoticeCopy(denied!, "teach").detail, /Teach only reads your material/)
  assert.match(turnNoticeCopy(denied!, "chat").detail, /Options/)
  // Moderation text names internal checks, so the copy never repeats it.
  assert.doesNotMatch(
    turnNoticeCopy({ kind: "moderation", message: "Model verification: x" }, "chat").detail,
    /verification/
  )
})

test("a redo resends the original request with its steer", () => {
  assert.equal(isTeachRedoStyle("simpler"), true)
  assert.equal(isTeachRedoStyle("louder"), false)
  const message = teachRedoMessage("Next section", "simpler")
  assert.ok(message.startsWith("Next section\n\n"))
  assert.ok(message.includes(TEACH_REDO_STYLES.simpler.steer))
})

test("the turn after a compaction restates material, outline, and plan but not the dialogue", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "Algorithms",
    unitTitle: "Week 6",
    sources: [{ filename: "slides.pdf", text: "Dijkstra relaxes edges." }],
    message: "Next section",
    includeContext: true,
    afterCompaction: true,
    history: [],
    outline: { title: "Shortest paths", sections: [{ id: "s1", title: "Dijkstra" }] },
    sectionIndex: 0,
    plan: [{ id: "s1", mode: "teach" }],
  })
  assert.match(prompt, /just compacted/)
  assert.match(prompt, /Dijkstra relaxes edges\./)
  assert.match(prompt, /"title":"Shortest paths"/)
  assert.match(prompt, /s1 teach/)
  assert.doesNotMatch(prompt, /CONVERSATION HISTORY/)
})

test("redo requests are parsed, and need a chat and a known style", () => {
  const parsed = parseWorkspaceChatRequest({
    chatId: "chat_1",
    clientMessageId: "client_1",
    message: "ignored",
    projectIds: [],
    attachments: [],
    redo: { messageId: "message_1", style: "example" },
  })
  assert.deepEqual(parsed.redo, { messageId: "message_1", style: "example" })
  assert.equal(parsed.message, "")
  assert.throws(() =>
    parseWorkspaceChatRequest({
      clientMessageId: "client_1",
      projectIds: [],
      attachments: [],
      redo: { messageId: "message_1", style: "example" },
    })
  )
  assert.throws(() =>
    parseWorkspaceChatRequest({
      chatId: "chat_1",
      clientMessageId: "client_1",
      projectIds: [],
      attachments: [],
      redo: { messageId: "message_1", style: "louder" },
    })
  )
})

test("a reply cut off by a full context is continued from its last words", () => {
  assert.equal(overflowContinuationMessage("Next section", ""), "Next section")
  const message = overflowContinuationMessage("Next section", `${"x".repeat(5_000)}the pattern in`)
  assert.match(message, /the pattern in\nPARTIAL REPLY END END/)
  assert.ok(message.length < 2_500)
})

test("a context that could not be freed says so instead of a generic failure", () => {
  const failure = workspaceChatFailure(
    new CardChatError("context-window", "This conversation ran out of room for the reply."),
    true
  )
  assert.equal(failure.reason, "context-window")
  assert.match(failure.message, /ran out of room/)
  assert.doesNotMatch(failure.message, /could not finish that reply/)
})

test("a prewarmed engine is claimed once by the matching turn", async () => {
  const key = prewarmedEngineKey("claude-code", WORKSPACE, false)
  const first = new FakeEngine("claude")
  const second = new FakeEngine("claude")
  offerPrewarmedEngine(key, first)
  offerPrewarmedEngine(key, second)
  // The older offer under the same key is closed.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(first.closed, true)
  assert.equal(
    claimPrewarmedEngine(prewarmedEngineKey("claude-code", WORKSPACE, true)),
    undefined
  )
  const result = await runProviderTextTurn({
    providerId: "claude-code",
    workspaceDirectory: WORKSPACE,
    prompt: "Teach me this unit.",
    sandbox: "read-only",
    approvalPolicy: "never",
  })
  assert.equal(result.text, "A clear answer.")
  assert.equal(second.started.length, 1)
  assert.equal(second.closed, true)
  assert.equal(claimPrewarmedEngine(key), undefined)
})

test("compacting a saved thread resumes it, compacts, and reads usage", async () => {
  const engine = new FakeEngine("claude")
  engine.contextReport = { usedTokens: 20_000, maxTokens: 200_000, percent: 10 }
  const result = await compactProviderThread(
    {
      providerId: "claude-code",
      workspaceDirectory: WORKSPACE,
      threadId: "thr_saved",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    { createEngine: () => engine }
  )
  assert.deepEqual(result, {
    compacted: true,
    contextUsage: { usedTokens: 20_000, maxTokens: 200_000, percent: 10 },
  })
  assert.deepEqual(engine.compactions, ["thr_saved"])
  assert.equal(engine.closed, true)

  const failing = new FakeEngine("codex")
  failing.compactScript = (turn) => turn.finish({ status: "failed" })
  const warn = console.warn
  console.warn = () => undefined
  try {
    const failed = await compactProviderThread(
      {
        providerId: "codex",
        workspaceDirectory: WORKSPACE,
        threadId: "thr_saved",
      },
      { createEngine: () => failing }
    )
    assert.deepEqual(failed, { compacted: false })
    assert.equal(failing.closed, true)
  } finally {
    console.warn = warn
  }
})
