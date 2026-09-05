/** Runs one resumable source-preparation step on the Mac without owning a network endpoint. */

import { randomUUID } from "node:crypto"
import { normalizeSourceDocument } from "./source-ingestion/normalize.ts"
import { segmentSourceDocument } from "./source-ingestion/segment.ts"
import {
  generateLearningForChunk,
  type LearningGenerationBatch,
  type LearningTextGenerator,
} from "./learning-generation.ts"

/** The persisted source snapshot and next checkpoint returned by a queue lease. */
export interface PreparationClaim {
  jobId: string
  nextChunk: number
  /** Approved research scope; omitted for generic source preparation. */
  learningScope?: string
  /** Bounded existing project topic titles offered for exact-title reuse. */
  existingTopicTitles: string[]
  source: {
    _id: string
    filename: string
    kind: "pdf" | "markdown" | "text" | "paste"
    extractedText: string
  }
}

/** Persistence operations needed by the local worker, injectable for failure tests. */
export interface PreparationQueue {
  /** Claims one queued or expired job, or returns null when nothing is available. */
  claimNext(args: {
    workerId: string
    leaseToken: string
  }): Promise<PreparationClaim | null>
  /** Atomically saves one validated batch and advances its source checkpoint. */
  commitChunk(args: {
    jobId: string
    leaseToken: string
    expectedOrdinal: number
    chunkId: string
    totalChunks: number
    batch: LearningGenerationBatch
  }): Promise<unknown>
  /** Records a safe failure only while this worker still owns this checkpoint. */
  failJob(args: {
    jobId: string
    leaseToken: string
    error: string
  }): Promise<unknown>
}

/** Result of one queue poll, with no source content included in diagnostic output. */
export type PreparationStepResult =
  | { status: "idle" }
  | { status: "prepared"; jobId: string; ordinal: number; totalChunks: number }

/** Claims, generates, and commits one chunk; incomplete work remains retryable. */
export async function runPreparationStep(
  queue: PreparationQueue,
  generate: LearningTextGenerator,
  options: { workerId: string; signal?: AbortSignal }
): Promise<PreparationStepResult> {
  options.signal?.throwIfAborted()
  if (!options.workerId.trim())
    throw new Error("Preparation worker id is required")
  const leaseToken = randomUUID()
  const claim = await queue.claimNext({
    workerId: options.workerId,
    leaseToken,
  })
  if (!claim) return { status: "idle" }
  try {
    options.signal?.throwIfAborted()
    const source = normalizeSourceDocument({
      sourceId: claim.source._id,
      filename: claim.source.filename,
      kind: claim.source.kind === "paste" ? "text" : claim.source.kind,
      text: claim.source.extractedText,
    })
    // These explicit sizes define version one's checkpoint boundaries. Changing
    // them requires migrating queued jobs rather than silently reusing ordinals.
    const chunks = segmentSourceDocument(source, {
      chunkSize: 5_000,
      overlap: 400,
    })
    const chunk = chunks[claim.nextChunk]
    if (!Number.isSafeInteger(claim.nextChunk) || !chunk)
      throw new Error("Source preparation checkpoint is outside its content")
    const batch = await generateLearningForChunk(chunk, generate, {
      signal: options.signal,
      learningScope: claim.learningScope,
      existingTopicTitles: claim.existingTopicTitles,
    })
    options.signal?.throwIfAborted()
    await queue.commitChunk({
      jobId: claim.jobId,
      leaseToken,
      expectedOrdinal: claim.nextChunk,
      chunkId: chunk.id,
      totalChunks: chunks.length,
      batch,
    })
    return {
      status: "prepared",
      jobId: claim.jobId,
      ordinal: claim.nextChunk,
      totalChunks: chunks.length,
    }
  } catch (error) {
    // Keep raw model output, source text, and transport errors out of persisted
    // failure copy. If the queue is unreachable, lease expiry permits recovery.
    await queue
      .failJob({
        jobId: claim.jobId,
        leaseToken,
        error: options.signal?.aborted
          ? "Preparation was interrupted. Retry to resume."
          : "This section could not be prepared. Retry to resume.",
      })
      .catch(() => undefined)
    throw error
  }
}
