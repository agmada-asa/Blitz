/** Checks that resumed and cancelled preparation cannot silently save the wrong chunk. */

import assert from "node:assert/strict"
import test from "node:test"
import { normalizeSourceDocument } from "../lib/server/source-ingestion/normalize.ts"
import { segmentSourceDocument } from "../lib/server/source-ingestion/segment.ts"
import {
  classifyPreparationFailure,
  runPreparationStep,
  type PreparationFailureCategory,
  type PreparationClaim,
  type PreparationQueue,
} from "../lib/server/preparation-worker.ts"
import { LearningGenerationError } from "../lib/server/learning-generation.ts"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"

test("classifies bounded preparation failures by phase", () => {
  assert.equal(
    classifyPreparationFailure(
      new LearningGenerationError("invalid-output", "raw output omitted"),
      "generation"
    ),
    "invalid-output" satisfies PreparationFailureCategory
  )
  assert.equal(
    classifyPreparationFailure(
      new SourceIngestionError("input-too-large", "raw details omitted"),
      "source"
    ),
    "source-invalid"
  )
  assert.equal(
    classifyPreparationFailure(new Error("commit failed"), "commit"),
    "save-failed"
  )
})

/** Creates a multi-chunk source with a saved checkpoint after its first chunk. */
function claimFixture(): PreparationClaim {
  return {
    jobId: "job-1",
    nextChunk: 1,
    learningScope: "Waveform timing",
    existingTopicTitles: ["Audio fundamentals", "Waveform basics"],
    source: {
      _id: "source-1",
      filename: "notes.txt",
      kind: "text",
      extractedText: "[Page 1]\nA waveform repeats in time.\n".repeat(300),
    },
  }
}

test("a resumed worker commits only the next persisted checkpoint", async () => {
  const claim = claimFixture()
  const source = normalizeSourceDocument({
    sourceId: claim.source._id,
    filename: claim.source.filename,
    kind: "text",
    text: claim.source.extractedText,
  })
  const chunks = segmentSourceDocument(source, {
    chunkSize: 5_000,
    overlap: 400,
  })
  const commits: Array<Parameters<PreparationQueue["commitChunk"]>[0]> = []
  const queue: PreparationQueue = {
    claimNext: async () => claim,
    commitChunk: async (args) => {
      commits.push(args)
    },
    failJob: async () => {
      assert.fail("A successful checkpoint must not fail")
    },
  }
  const result = await runPreparationStep(
    queue,
    async (prompt) => {
      assert.ok(prompt.includes(chunks[1].id))
      assert.ok(prompt.includes("Waveform timing"))
      assert.ok(prompt.includes("Waveform basics"))
      return JSON.stringify({
        summary: "Waveform repetition.",
        concepts: [
          { key: "waveform", title: "Waveforms", topicTitle: "Sound" },
        ],
        items: [
          {
            conceptKey: "waveform",
            type: "explain",
            title: "Repeating waves",
            body: "A waveform repeats in time.",
            sourceChunkIds: [chunks[1].id],
          },
        ],
      })
    },
    { workerId: "worker-test" }
  )
  assert.equal(result.status, "prepared")
  assert.equal(commits.length, 1)
  assert.equal(commits[0].expectedOrdinal, 1)
  assert.equal(commits[0].chunkId, chunks[1].id)
  assert.equal(commits[0].totalChunks, chunks.length)
})

test("cancellation during generation releases work without persisting its response", async () => {
  const controller = new AbortController()
  let failures = 0
  const queue: PreparationQueue = {
    claimNext: async () => claimFixture(),
    commitChunk: async () => {
      assert.fail("Cancelled generation must not commit")
    },
    failJob: async ({ error }) => {
      failures += 1
      assert.equal(error, "Preparation was interrupted. Retry to resume.")
    },
  }
  await assert.rejects(
    runPreparationStep(
      queue,
      async () => {
        controller.abort()
        return "untrusted output which must never be saved"
      },
      { workerId: "worker-test", signal: controller.signal }
    ),
    /abort/i
  )
  assert.equal(failures, 1)
})
