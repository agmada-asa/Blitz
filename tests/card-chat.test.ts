/**
 * Exercises card-chat orchestration with an in-memory transport. No Codex
 * process, model turn, subscription usage, or network connection is used.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CardChatError,
  buildCardChatPrompt,
  MAX_CARD_CHAT_STREAM_TEXT_LENGTH,
  runCardChat,
  type CardChatCard,
  type CardChatEvent,
  type CardChatSource,
  type CardChatTransport,
} from "../lib/server/card-chat.ts"
import type {
  CodexAppServerEvent,
  CodexResumeThreadOptions,
  CodexStartThreadOptions,
  CodexStartTurnOptions,
  CodexThreadResponse,
  CodexTurnResponse,
} from "../lib/server/codex-app-server.ts"

/** Stable card fixture used by the orchestration tests. */
const card: CardChatCard = {
  id: "card-1",
  title: "Envelope shaping",
  body: "An envelope changes the amplitude contour of a sound over time.",
  sourceLabel: "Sound notes",
}

/** Stable source fixture used by the orchestration tests. */
const source: CardChatSource = {
  id: "source-1",
  filename: "notes.md",
  extractedText: "An envelope describes changes in amplitude over time.",
}

/** Controllable transport that records lifecycle calls and emits notifications. */
class FakeTransport implements CardChatTransport {
  /** Registered event listener. */
  private listener?: (event: CodexAppServerEvent) => void
  /** Whether the transport was closed. */
  closed = false
  /** Thread resume call count. */
  resumeCalls = 0
  /** Thread start options observed by the fixture. */
  startOptions: CodexStartThreadOptions | undefined
  /** Resume options observed by the fixture. */
  resumeOptions: CodexResumeThreadOptions | undefined
  /** Interrupt call count. */
  interruptCalls = 0
  /** Turn completion behavior. */
  completeImmediately = false
  /** Whether the turn/start response is returned before completion. */
  respondTurnImmediately = false
  /** Whether completion arrives without assistant text. */
  emptyCompletion = false
  /** Text sent by the immediate completion fixture. */
  deltaText = "A clear answer."
  /** Pending turn promise resolver for abort tests. */
  private resolveTurn?: (response: CodexTurnResponse) => void
  /** Turn options observed by the fixture. */
  turnOptions: CodexStartTurnOptions | undefined

  /** Registers the orchestrator listener. */
  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  /** Returns a server-issued thread for a new conversation. */
  async startThread(
    options: CodexStartThreadOptions = {}
  ): Promise<CodexThreadResponse> {
    this.startOptions = options
    return { thread: { id: "thr_new" } }
  }

  /** Returns a server-issued thread for a persisted conversation. */
  async resumeThread(
    threadId: string,
    options: CodexResumeThreadOptions = {}
  ): Promise<CodexThreadResponse> {
    this.resumeCalls += 1
    this.resumeOptions = options
    return { thread: { id: threadId } }
  }

  /** Starts a turn and optionally races completion before its response. */
  startTurn(
    threadId: string,
    _options: CodexStartTurnOptions
  ): Promise<CodexTurnResponse> {
    this.turnOptions = _options
    const response = { turn: { id: "turn_1", status: "inProgress" } }
    if (this.emptyCompletion) {
      this.emit({
        type: "notification",
        notification: {
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "turn_1", status: "completed", items: [] },
          },
        },
      })
      return Promise.resolve(response)
    }
    if (this.completeImmediately) {
      this.emit({
        type: "notification",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId: "turn_1",
            itemId: "item-1",
            delta: this.deltaText,
          },
        },
      })
      this.emit({
        type: "notification",
        notification: {
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "turn_1", status: "completed", items: [] },
          },
        },
      })
      return Promise.resolve(response)
    }
    if (this.respondTurnImmediately) return Promise.resolve(response)
    return new Promise((resolve) => {
      this.resolveTurn = resolve
    })
  }

  /** Resolves an in-flight turn for normal completion tests. */
  finishTurn(threadId = "thr_new"): void {
    this.emit({
      type: "notification",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId: "turn_1",
          itemId: "item-1",
          delta: "A clear answer.",
        },
      },
    })
    this.emit({
      type: "notification",
      notification: {
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_1", status: "completed", items: [] },
        },
      },
    })
    this.resolveTurn?.({ turn: { id: "turn_1", status: "inProgress" } })
  }

  /** Records interruption requested by abort or timeout cleanup. */
  async interruptTurn(_threadId: string, _turnId: string): Promise<void> {
    void _threadId
    void _turnId
    this.interruptCalls += 1
  }

  /** Closes the in-memory transport. */
  async close(): Promise<void> {
    this.closed = true
  }

  /** Emits one transport event to the orchestrator. */
  private emit(event: CodexAppServerEvent): void {
    this.listener?.(event)
  }
}

/** Creates a fake transport factory while preserving its instance for assertions. */
function factoryFor(transport: FakeTransport): () => FakeTransport {
  return () => transport
}

test("builds a bounded prompt that requires and preserves the learner question", () => {
  const prompt = buildCardChatPrompt({
    card,
    source: { ...source, extractedText: "x".repeat(20_000) },
    question: "Why does the envelope matter?",
  })
  assert.match(prompt, /Why does the envelope matter\?/)
  assert.match(prompt, /context truncated by Blitz/)
  assert.ok(prompt.length < 16_000)
  assert.throws(
    () => buildCardChatPrompt({ card, source, question: "   " }),
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "invalid-input"
  )
})

test("requires an explicit absolute workspace before creating a transport", async () => {
  let created = false
  await assert.rejects(
    runCardChat(
      { workspaceDirectory: "relative", card, source, question: "Why?" },
      {
        createTransport: () => {
          created = true
          throw new Error("transport should not be created")
        },
      }
    ),
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "invalid-input"
  )
  assert.equal(created, false)
})

test("pre-aborted requests do not create a transport or leak a rejection", async () => {
  const controller = new AbortController()
  controller.abort()
  let created = false
  await assert.rejects(
    runCardChat(
      {
        workspaceDirectory: "/tmp/blitz-owned-workspace",
        card,
        source,
        question: "Why?",
        signal: controller.signal,
      },
      {
        createTransport: () => {
          created = true
          throw new Error("transport should not be created")
        },
      }
    ),
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "aborted"
  )
  assert.equal(created, false)
})

test("returns IDs and handles completion racing the turn/start response", async () => {
  const transport = new FakeTransport()
  transport.completeImmediately = true
  const events: CardChatEvent[] = []
  const result = await runCardChat(
    {
      workspaceDirectory: "/tmp/blitz-owned-workspace",
      card,
      source,
      question: "What changes?",
      model: "gpt-test",
      effort: "low",
    },
    {
      createTransport: factoryFor(transport),
      onEvent: (event) => events.push(event),
    }
  )
  assert.deepEqual(result, {
    threadId: "thr_new",
    turnId: "turn_1",
    text: "A clear answer.",
  })
  assert.equal(events.filter((event) => event.type === "text-delta").length, 1)
  assert.deepEqual(
    events.find((event) => event.type === "turn-started"),
    { type: "turn-started", threadId: "thr_new", turnId: "turn_1" }
  )
  assert.equal(events.filter((event) => event.type === "completed").length, 1)
  assert.equal(transport.closed, true)
  assert.equal(transport.startOptions?.approvalPolicy, "on-request")
  assert.equal(transport.startOptions?.sandbox, "read-only")
  assert.equal(transport.startOptions?.model, "gpt-test")
  assert.equal(transport.turnOptions?.model, "gpt-test")
  assert.equal(transport.turnOptions?.effort, "low")
})

test("resumes a supplied persistent thread and streams activity", async () => {
  const transport = new FakeTransport()
  transport.completeImmediately = true
  const events: CardChatEvent[] = []
  const result = await runCardChat(
    {
      workspaceDirectory: "/tmp/blitz-owned-workspace",
      card,
      source,
      question: "How does it shape sound?",
      threadId: "thr_saved",
    },
    {
      createTransport: factoryFor(transport),
      onEvent: (event) => events.push(event),
    }
  )
  assert.equal(result.threadId, "thr_saved")
  assert.equal(transport.resumeCalls, 1)
  assert.equal(transport.resumeOptions?.approvalPolicy, "on-request")
  assert.ok(events.some((event) => event.type === "activity"))
})

test("aborts an in-flight turn, interrupts it, closes transport, and emits one error", async () => {
  const transport = new FakeTransport()
  transport.respondTurnImmediately = true
  const controller = new AbortController()
  const events: CardChatEvent[] = []
  const run = runCardChat(
    {
      workspaceDirectory: "/tmp/blitz-owned-workspace",
      card,
      source,
      question: "Explain this.",
      signal: controller.signal,
    },
    {
      createTransport: factoryFor(transport),
      onEvent: (event) => events.push(event),
    }
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "aborted"
  )
  assert.equal(transport.interruptCalls, 1)
  assert.equal(transport.closed, true)
  assert.deepEqual(
    events.find((event) => event.type === "turn-started"),
    { type: "turn-started", threadId: "thr_new", turnId: "turn_1" }
  )
  assert.equal(events.filter((event) => event.type === "error").length, 1)
})

test("times out an in-flight turn and cleans up its transport", async () => {
  const transport = new FakeTransport()
  transport.respondTurnImmediately = true
  const events: CardChatEvent[] = []
  const run = runCardChat(
    {
      workspaceDirectory: "/tmp/blitz-owned-workspace",
      card,
      source,
      question: "How long does it last?",
      timeoutMs: 10,
    },
    {
      createTransport: factoryFor(transport),
      onEvent: (event) => events.push(event),
    }
  )
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "timeout"
  )
  assert.equal(transport.interruptCalls, 1)
  assert.equal(transport.closed, true)
  assert.deepEqual(
    events.find((event) => event.type === "turn-started"),
    { type: "turn-started", threadId: "thr_new", turnId: "turn_1" }
  )
  assert.equal(events.filter((event) => event.type === "error").length, 1)
})

test("does not report success when completion contains no assistant text", async () => {
  const transport = new FakeTransport()
  transport.emptyCompletion = true
  const events: CardChatEvent[] = []
  await assert.rejects(
    runCardChat(
      {
        workspaceDirectory: "/tmp/blitz-owned-workspace",
        card,
        source,
        question: "Why?",
      },
      {
        createTransport: factoryFor(transport),
        onEvent: (event) => events.push(event),
      }
    ),
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "turn-failed"
  )
  assert.equal(events.filter((event) => event.type === "completed").length, 0)
  assert.equal(events.filter((event) => event.type === "error").length, 1)
})

test("fails when streamed assistant text exceeds the collection bound", async () => {
  const transport = new FakeTransport()
  transport.completeImmediately = true
  transport.deltaText = "x".repeat(MAX_CARD_CHAT_STREAM_TEXT_LENGTH + 1)
  await assert.rejects(
    runCardChat(
      {
        workspaceDirectory: "/tmp/blitz-owned-workspace",
        card,
        source,
        question: "Why?",
      },
      { createTransport: factoryFor(transport) }
    ),
    (error: unknown) =>
      error instanceof CardChatError && error.reason === "transport"
  )
})
