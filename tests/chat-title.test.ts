/**
 * Tests cheapest model selection, prompt assembly, and output sanitization for chat titles.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  AI_MODEL_COST_RANKS,
  resolveCheapestAiModelSelection,
} from "../lib/ai-model-settings.ts"
import {
  buildChatTitlePrompt,
  parseChatTitleOutput,
} from "../lib/server/chat-title.ts"

test("selects the cheapest model with lowest reasoning for each provider", () => {
  // Codex: Spark is the cheapest model with "low" reasoning effort
  const codexSelection = resolveCheapestAiModelSelection("codex")
  assert.equal(codexSelection.providerId, "codex")
  assert.equal(codexSelection.model, "gpt-5.3-codex-spark")
  assert.equal(codexSelection.effort, "low")

  // Claude Code: Haiku is the cheapest model with "default" (no) reasoning effort
  const claudeSelection = resolveCheapestAiModelSelection("claude-code")
  assert.equal(claudeSelection.providerId, "claude-code")
  assert.equal(claudeSelection.model, "haiku")
  assert.equal(claudeSelection.effort, "default")

  // OpenCode: big-pickle with default reasoning
  const opencodeSelection = resolveCheapestAiModelSelection("opencode")
  assert.equal(opencodeSelection.providerId, "opencode")
  assert.equal(opencodeSelection.model, "opencode/big-pickle")
  assert.equal(opencodeSelection.effort, "default")

  // Antigravity: default with default reasoning
  const antigravitySelection = resolveCheapestAiModelSelection("antigravity")
  assert.equal(antigravitySelection.providerId, "antigravity")
  assert.equal(antigravitySelection.model, "antigravity/default")
  assert.equal(antigravitySelection.effort, "default")
})

test("respects environment variable overrides for model and reasoning effort", () => {
  const selection = resolveCheapestAiModelSelection("codex", {
    modelEnvironmentFallback: "gpt-5.4-mini",
    effortEnvironmentFallback: "medium",
  })
  assert.equal(selection.providerId, "codex")
  assert.equal(selection.model, "gpt-5.4-mini")
  assert.equal(selection.effort, "medium")
})

test("verifies model cost rankings establish expected relative ordering", () => {
  assert.ok(
    (AI_MODEL_COST_RANKS["gpt-5.3-codex-spark"] ?? 99) <
      (AI_MODEL_COST_RANKS["gpt-5.4-mini"] ?? 99)
  )
  assert.ok(
    (AI_MODEL_COST_RANKS["gpt-5.4-mini"] ?? 99) <
      (AI_MODEL_COST_RANKS["gpt-5.6-luna"] ?? 99)
  )
  assert.ok(
    (AI_MODEL_COST_RANKS["haiku"] ?? 99) <
      (AI_MODEL_COST_RANKS["sonnet"] ?? 99)
  )
  assert.ok(
    (AI_MODEL_COST_RANKS["sonnet"] ?? 99) <
      (AI_MODEL_COST_RANKS["opus"] ?? 99)
  )
})

test("builds title generation prompt with user message and optional context", () => {
  const promptWithoutContext = buildChatTitlePrompt("What is photosynthesis?")
  assert.match(promptWithoutContext, /What is photosynthesis\?/)
  assert.match(promptWithoutContext, /succinct, descriptive title/)
  assert.doesNotMatch(promptWithoutContext, /Context items attached/)

  const promptWithContext = buildChatTitlePrompt("Summarize this document", [
    "Biology Lecture 1.pdf",
    "Cell Anatomy Card",
  ])
  assert.match(promptWithContext, /Summarize this document/)
  assert.match(
    promptWithContext,
    /Context items attached to this chat: Biology Lecture 1\.pdf, Cell Anatomy Card/
  )
})

test("cleans, strips markdown, quotes, prefixes, and punctuation in title output", () => {
  const fallback = "Initial user query"

  // Strips standard double quotes
  assert.equal(
    parseChatTitleOutput('"Photosynthesis Basics"', fallback),
    "Photosynthesis Basics"
  )

  // Strips typographic quotes
  assert.equal(
    parseChatTitleOutput('“Photosynthesis Basics”', fallback),
    "Photosynthesis Basics"
  )

  // Strips prefixes like Title: or Chat Title:
  assert.equal(
    parseChatTitleOutput("Title: Quantum Computing Overview", fallback),
    "Quantum Computing Overview"
  )
  assert.equal(
    parseChatTitleOutput("Chat Title: Neural Networks", fallback),
    "Neural Networks"
  )

  // Strips markdown styling (bold, backticks, asterisks)
  assert.equal(
    parseChatTitleOutput("**Operating Systems Scheduling**", fallback),
    "Operating Systems Scheduling"
  )
  assert.equal(
    parseChatTitleOutput("`React Hooks Guide`", fallback),
    "React Hooks Guide"
  )

  // Strips trailing period or punctuation
  assert.equal(
    parseChatTitleOutput("Introduction to Astronomy.", fallback),
    "Introduction to Astronomy"
  )
  assert.equal(
    parseChatTitleOutput("Organic Chemistry Review!", fallback),
    "Organic Chemistry Review"
  )

  // Takes first line and collapses extra whitespace
  assert.equal(
    parseChatTitleOutput("Multi-line\nSecond line explanation", fallback),
    "Multi-line"
  )
  assert.equal(
    parseChatTitleOutput("  Spaced    Out   Title  ", fallback),
    "Spaced Out Title"
  )

  // Returns fallback when output is empty or purely punctuation
  assert.equal(parseChatTitleOutput("", fallback), fallback)
  assert.equal(parseChatTitleOutput("   ", fallback), fallback)
  assert.equal(parseChatTitleOutput('"."', fallback), fallback)

  // Truncates gracefully to 64 chars if excessively long
  const veryLong = "A".repeat(80)
  const truncated = parseChatTitleOutput(veryLong, fallback)
  assert.ok(truncated.length <= 64)
  assert.ok(truncated.endsWith("…"))
})

test("generateChatTitle gracefully returns fallback title on aborted signal", async () => {
  const { generateChatTitle } = await import("../lib/server/chat-title.ts")
  const abortController = new AbortController()
  abortController.abort()

  const title = await generateChatTitle({
    message: "Test message",
    providerId: "codex",
    fallbackTitle: "Fallback Title",
    signal: abortController.signal,
  })

  assert.equal(title, "Fallback Title")
})

