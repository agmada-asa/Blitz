/** Exercises persisted chat-worker orchestration without a Convex or Codex connection. */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeSourceDocument } from "../lib/server/source-ingestion/normalize.ts"
import { segmentSourceDocument } from "../lib/server/source-ingestion/segment.ts"
import {
  runChatWorkerStep,
  type ChatWorkerQueue,
  type ChatWorkContext,
} from "../lib/server/chat-worker.ts"

/** Builds a deterministic source context matching preparation segmentation. */
function sourceContext(): ChatWorkContext {
  const extractedText = "A learner can inspect this prepared source chunk."
  const normalized = normalizeSourceDocument({
    sourceId: "source-1",
    filename: "notes.txt",
    kind: "text",
    text: extractedText,
  })
  const chunk = segmentSourceDocument(normalized, {
    chunkSize: 5_000,
    overlap: 400,
  })[0]!
  return {
    projectId: "project-1",
    itemId: "item-1",
    item: {
      id: "item-1",
      title: "Prepared card",
      body: "A card body.",
      sourceLabel: "notes.txt",
    },
    source: {
      id: "source-1",
      filename: "notes.txt",
      kind: "text",
      extractedText,
      chunkOrdinal: 0,
      chunkId: chunk.id,
    },
    question: "Why does this matter?",
  }
}

/** Creates a queue double that records the worker's atomic completion call. */
function queueDouble(context: ChatWorkContext): {
  queue: ChatWorkerQueue
  completed: unknown[]
  failures: unknown[]
} {
  const completed: unknown[] = []
  const failures: unknown[] = []
  const claim = {
    messageId: "message-1",
    conversationId: "conversation-1",
    projectId: context.projectId,
    itemId: context.itemId,
    codexThreadId: "thread-old",
    leaseToken: "lease-token",
    question: context.question,
  }
  return {
    completed,
    failures,
    queue: {
      claimNext: async () => claim,
      getWorkContext: async () => context,
      progress: async () => undefined,
      complete: async (value) => {
        completed.push(value)
      },
      fail: async (value) => {
        failures.push(value)
      },
    },
  }
}

/** Verifies source reconstruction, persisted thread resume, and atomic completion. */
test("chat worker completes a claimed card turn with bounded prepared context", async () => {
  const context = sourceContext()
  const fixture = queueDouble(context)
  const workspace = await mkdtemp(join(tmpdir(), "blitz-chat-worker-test-"))
  try {
    const result = await runChatWorkerStep({
      queue: fixture.queue,
      workerId: "worker-1",
      workspaceDirectory: workspace,
      runTurn: async (request) => {
        assert.equal(request.threadId, "thread-old")
        assert.equal(request.source.extractedText, context.source.extractedText)
        assert.match(request.question, /Why does this matter\?/)
        return {
          threadId: "thread-old",
          turnId: "turn-1",
          text: "It supplies context.",
        }
      },
    })
    assert.equal(result.status, "completed")
    assert.equal(fixture.failures.length, 0)
    assert.equal(fixture.completed.length, 1)
    assert.equal(
      (fixture.completed[0] as { reply: string }).reply,
      "It supplies context."
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/** Verifies a failed turn is recorded and does not become a false success. */
test("chat worker records a turn failure for deliberate retry", async () => {
  const context = sourceContext()
  const fixture = queueDouble(context)
  const workspace = await mkdtemp(join(tmpdir(), "blitz-chat-worker-test-"))
  try {
    const result = await runChatWorkerStep({
      queue: fixture.queue,
      workerId: "worker-1",
      workspaceDirectory: workspace,
      runTurn: async () => {
        throw new Error("simulated transport failure")
      },
    })
    assert.deepEqual(result, {
      status: "failed",
      messageId: "message-1",
      conversationId: "conversation-1",
    })
    assert.equal(fixture.completed.length, 0)
    assert.equal(
      (fixture.failures[0] as { error: string }).error,
      "Card chat could not complete. Retry to try again."
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/** Confirms transport fragments reach persistence before the authoritative terminal answer. */
test("worker persists streamed text before completion", async () => {
  const fixture = queueDouble(sourceContext())
  const writes: string[] = []
  fixture.queue.progress = async ({ reply }) => {
    writes.push(reply)
  }
  const workspace = await mkdtemp(join(tmpdir(), "blitz-chat-worker-test-"))
  try {
    const result = await runChatWorkerStep({
      queue: fixture.queue,
      workerId: "worker-1",
      workspaceDirectory: workspace,
      runTurn: async (_, { onEvent }) => {
        onEvent({
          type: "text-delta",
          threadId: "thread-old",
          turnId: "turn-1",
          delta: "Partial",
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        assert.deepEqual(writes, ["Partial"])
        assert.equal(fixture.completed.length, 0)
        onEvent({
          type: "text-delta",
          threadId: "thread-old",
          turnId: "turn-1",
          delta: " answer",
        })
        return {
          threadId: "thread-old",
          turnId: "turn-1",
          text: "Authoritative answer",
        }
      },
    })
    assert.equal(result.status, "completed")
    assert.deepEqual(writes, ["Partial", "Partial answer"])
    assert.equal(
      (fixture.completed[0] as { reply: string }).reply,
      "Authoritative answer"
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
