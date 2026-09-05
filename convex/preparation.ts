/**
 * Owns the resumable source-preparation queue used by the local Mac worker.
 *
 * Jobs snapshot an existing source, lease one worker at a time, and commit one
 * validated generation batch per chunk. All writes are scoped to the source's
 * project; this first personal deployment has no multi-user authorization.
 */

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  MAX_ITEMS_PER_CHUNK,
  validateLearningGeneration,
  type LearningGenerationBatch,
} from "../lib/learning/generation"

/** Maximum source snapshot accepted by one preparation job. */
export const MAX_PREPARATION_SOURCE_LENGTH = 120_000
/** Lease duration for one local worker claim. */
export const PREPARATION_LEASE_MS = 5 * 60 * 1000
/** Maximum chunks accepted for one source. */
export const MAX_PREPARATION_CHUNKS = 1_000
/** Maximum jobs inspected in one non-paginated claim query. */
const CLAIM_SCAN_LIMIT = 50
/** Safe source error shown when a completed job produced no learning items. */
const NO_STUDY_CONTENT_ERROR =
  "No study content was generated. Add clearer notes or another source."

/** Read-only Convex context shared by queue helpers. */
type ReadContext = Pick<QueryCtx, "db">

/** Ensures a text identifier is present and bounded. */
function boundedId(value: string, label: string, maximum = 200): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > maximum) throw new Error(`${label} is too long`)
  return trimmed
}

/** Requires a project and source pair to belong to the same project. */
async function requireSource(
  ctx: ReadContext,
  projectId: Id<"projects">,
  sourceId: Id<"sources">
): Promise<Doc<"sources">> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
  const source = await ctx.db.get(sourceId)
  if (!source || source.projectId !== projectId)
    throw new Error("Source does not belong to project")
  if (source.extractedText.length > MAX_PREPARATION_SOURCE_LENGTH)
    throw new Error("Source is too large for preparation")
  return source
}

/** Returns a source snapshot in the shape handed to the local worker. */
function sourceForWorker(job: Doc<"preparationJobs">) {
  return {
    _id: job.sourceId,
    projectId: job.projectId,
    filename: job.sourceFilename,
    kind: job.sourceKind,
    extractedText: job.sourceTextSnapshot,
  }
}

/** Returns the current queue progress in a stable worker-facing shape. */
function progressFor(
  job: Doc<"preparationJobs">,
  chunkId?: string,
  chunkOrdinal?: number
) {
  return {
    jobId: job._id,
    status: job.status,
    chunkId: chunkId ?? null,
    chunkOrdinal: chunkOrdinal ?? null,
    nextChunkOrdinal: job.nextChunkOrdinal,
    totalChunks: job.totalChunks ?? null,
    // Older jobs predate this counter; null keeps their progress honest.
    generatedItemCount: job.generatedItemCount ?? null,
    isComplete: job.status === "completed",
  }
}

/** Finds a preparation job by its project and source idempotency pair. */
async function findJobForSource(
  ctx: ReadContext,
  projectId: Id<"projects">,
  sourceId: Id<"sources">
): Promise<Doc<"preparationJobs"> | null> {
  const jobs = await ctx.db
    .query("preparationJobs")
    .withIndex("by_project_source", (q) =>
      q.eq("projectId", projectId).eq("sourceId", sourceId)
    )
    .collect()
  return jobs[0] ?? null
}

/** Finds a chunk checkpoint by job and ordinal. */
async function findChunkByOrdinal(
  ctx: ReadContext,
  jobId: Id<"preparationJobs">,
  ordinal: number
): Promise<Doc<"preparationChunks"> | null> {
  const chunks = await ctx.db
    .query("preparationChunks")
    .withIndex("by_job_ordinal", (q) =>
      q.eq("jobId", jobId).eq("ordinal", ordinal)
    )
    .collect()
  return chunks[0] ?? null
}

/** Requires a live lease before a worker can modify a job. */
function requireLiveLease(
  job: Doc<"preparationJobs">,
  leaseToken: string,
  now: number
): void {
  if (
    job.status !== "leased" ||
    job.leaseToken !== leaseToken ||
    job.leaseExpiresAt === undefined ||
    job.leaseExpiresAt <= now
  )
    throw new Error("Preparation lease is missing or expired")
}

/** Validates the worker batch against the exact source chunk identifier. */
function validateChunkBatch(
  batch: unknown,
  chunkId: string
): LearningGenerationBatch {
  return validateLearningGeneration(batch, chunkId)
}

/** Enqueues one immutable source snapshot, returning an existing job on retry. */
export const enqueue = mutation({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const source = await requireSource(ctx, args.projectId, args.sourceId)
    const existing = await findJobForSource(ctx, args.projectId, args.sourceId)
    if (existing)
      return {
        jobId: existing._id,
        status: existing.status,
        alreadyQueued: true,
      }
    const now = Date.now()
    const jobId = await ctx.db.insert("preparationJobs", {
      projectId: args.projectId,
      sourceId: args.sourceId,
      sourceTextSnapshot: source.extractedText,
      sourceFilename: source.filename,
      sourceKind: source.kind,
      status: "queued",
      nextChunkOrdinal: 0,
      generatedItemCount: 0,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    return { jobId, status: "queued" as const, alreadyQueued: false }
  },
})

/** Claims the oldest queued job or a job whose previous lease expired. */
export const claimNext = mutation({
  args: { workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const workerId = boundedId(args.workerId, "Worker id")
    const leaseToken = boundedId(args.leaseToken, "Lease token")
    const now = Date.now()
    const owned = await ctx.db
      .query("preparationJobs")
      .withIndex("by_leaseToken", (q) => q.eq("leaseToken", leaseToken))
      .collect()
    const activeOwned = owned.find(
      (job) =>
        job.status === "leased" &&
        job.workerId === workerId &&
        (job.leaseExpiresAt ?? 0) > now
    )
    if (activeOwned) {
      return {
        jobId: activeOwned._id,
        leaseToken,
        nextChunk: { ordinal: activeOwned.nextChunkOrdinal },
        totalChunks: activeOwned.totalChunks ?? null,
        ...(activeOwned.learningScope
          ? { learningScope: activeOwned.learningScope }
          : {}),
        source: sourceForWorker(activeOwned),
      }
    }
    const queued = await ctx.db
      .query("preparationJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const leased = await ctx.db
      .query("preparationJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "leased"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const candidate = [...queued, ...leased]
      .filter(
        (job) =>
          job.status === "queued" ||
          (job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now)
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0]
    if (!candidate) return null
    const leaseExpiresAt = now + PREPARATION_LEASE_MS
    await ctx.db.patch(candidate._id, {
      status: "leased",
      workerId,
      leaseToken,
      leaseExpiresAt,
      attemptCount: candidate.attemptCount + 1,
      updatedAt: now,
    })
    return {
      jobId: candidate._id,
      leaseToken,
      nextChunk: { ordinal: candidate.nextChunkOrdinal },
      totalChunks: candidate.totalChunks ?? null,
      ...(candidate.learningScope
        ? { learningScope: candidate.learningScope }
        : {}),
      source: sourceForWorker({
        ...candidate,
        status: "leased",
        workerId,
        leaseToken,
        leaseExpiresAt,
      }),
    }
  },
})

/** Commits one validated generation chunk and advances the job checkpoint atomically. */
export const commitChunk = mutation({
  args: {
    jobId: v.id("preparationJobs"),
    leaseToken: v.string(),
    expectedOrdinal: v.number(),
    chunkId: v.string(),
    totalChunks: v.number(),
    batch: v.any(),
  },
  handler: async (ctx, args) => {
    const leaseToken = boundedId(args.leaseToken, "Lease token")
    const chunkId = boundedId(args.chunkId, "Chunk id", 200)
    if (!Number.isSafeInteger(args.expectedOrdinal) || args.expectedOrdinal < 0)
      throw new Error("Expected chunk ordinal is invalid")
    if (
      !Number.isSafeInteger(args.totalChunks) ||
      args.totalChunks < 1 ||
      args.totalChunks > MAX_PREPARATION_CHUNKS ||
      args.expectedOrdinal >= args.totalChunks
    )
      throw new Error("Total chunk count is invalid")
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Preparation job not found")
    const completed = await findChunkByOrdinal(
      ctx,
      args.jobId,
      args.expectedOrdinal
    )
    if (completed) {
      if (
        completed.chunkId !== chunkId ||
        completed.totalChunks !== args.totalChunks
      )
        throw new Error("Chunk checkpoint conflicts with completed chunk")
      return progressFor(job, completed.chunkId, completed.ordinal)
    }
    if (args.expectedOrdinal !== job.nextChunkOrdinal)
      throw new Error("Chunk ordinal does not match job checkpoint")
    const now = Date.now()
    requireLiveLease(job, leaseToken, now)
    if (job.totalChunks !== undefined && job.totalChunks !== args.totalChunks)
      throw new Error("Total chunk count conflicts with job")
    const batch = validateChunkBatch(args.batch, chunkId)
    const chunkRecordId = await ctx.db.insert("preparationChunks", {
      jobId: args.jobId,
      sourceId: job.sourceId,
      ordinal: args.expectedOrdinal,
      chunkId,
      totalChunks: args.totalChunks,
      createdAt: now,
    })
    const topicIds = new Map<string, Id<"topics">>()
    const conceptIds = new Map<string, Id<"concepts">>()
    for (const concept of batch.concepts) {
      let topicId = topicIds.get(concept.topicTitle)
      if (!topicId) {
        const existingTopic = await ctx.db
          .query("topics")
          .withIndex("by_project_title", (q) =>
            q.eq("projectId", job.projectId).eq("title", concept.topicTitle)
          )
          .first()
        topicId =
          existingTopic?._id ??
          (await ctx.db.insert("topics", {
            projectId: job.projectId,
            title: concept.topicTitle,
            createdAt: now,
          }))
        topicIds.set(concept.topicTitle, topicId)
      }
      const existingConcept = await ctx.db
        .query("concepts")
        .withIndex("by_project_title", (q) =>
          q.eq("projectId", job.projectId).eq("title", concept.title)
        )
        .filter((q) => q.eq(q.field("topicId"), topicId))
        .first()
      if (
        existingConcept &&
        !existingConcept.sourceIds.includes(job.sourceId)
      ) {
        await ctx.db.patch(existingConcept._id, {
          sourceIds: [...existingConcept.sourceIds, job.sourceId],
        })
      }
      const conceptId =
        existingConcept?._id ??
        (await ctx.db.insert("concepts", {
          projectId: job.projectId,
          topicId,
          title: concept.title,
          sourceIds: [job.sourceId],
          createdAt: now,
        }))
      conceptIds.set(concept.key, conceptId)
    }
    for (const [index, item] of batch.items.entries()) {
      const conceptId = conceptIds.get(item.conceptKey)
      if (!conceptId)
        throw new Error("Generated item references unknown concept")
      await ctx.db.insert("learningItems", {
        projectId: job.projectId,
        conceptId,
        sourceIds: [job.sourceId],
        type: item.type,
        title: item.title,
        body: item.body,
        ...(item.question ? { question: item.question } : {}),
        ...(item.options ? { options: item.options } : {}),
        ...(item.correctOptionId
          ? { correctOptionId: item.correctOptionId }
          : {}),
        ...(item.correctOptionIds
          ? { correctOptionIds: item.correctOptionIds }
          : {}),
        ...(item.correctAnswer !== undefined
          ? { correctAnswer: item.correctAnswer }
          : {}),
        sourceChunkId: chunkRecordId,
        sourceChunkOrdinal: args.expectedOrdinal,
        order: args.expectedOrdinal * MAX_ITEMS_PER_CHUNK + index,
        createdAt: now,
      })
    }
    const nextChunkOrdinal = args.expectedOrdinal + 1
    const isComplete = nextChunkOrdinal === args.totalChunks
    // New jobs count from zero. For a legacy job with prior chunks, preserve an
    // unknown total rather than presenting a misleading partial count.
    const generatedItemCount =
      job.generatedItemCount === undefined
        ? job.nextChunkOrdinal === 0
          ? batch.items.length
          : undefined
        : job.generatedItemCount + batch.items.length
    await ctx.db.patch(args.jobId, {
      status: isComplete ? "completed" : "queued",
      lastError: undefined,
      nextChunkOrdinal,
      totalChunks: args.totalChunks,
      ...(generatedItemCount === undefined ? {} : { generatedItemCount }),
      // Each worker step releases its lease. A fresh claim can immediately
      // continue this source, and lost commit responses cannot fail a later step.
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
    await ctx.db.patch(job.sourceId, {
      status:
        isComplete && generatedItemCount === 0
          ? "failed"
          : isComplete
            ? "ready"
            : "processing",
      ...(isComplete
        ? {
            summary: batch.summary,
            error:
              generatedItemCount === 0 ? NO_STUDY_CONTENT_ERROR : undefined,
          }
        : {}),
    })
    const updatedJob = await ctx.db.get(args.jobId)
    if (!updatedJob) throw new Error("Preparation job disappeared")
    return progressFor(updatedJob, chunkId, args.expectedOrdinal)
  },
})

/** Marks a leased job failed while retaining committed chunk progress for retry. */
export const failJob = mutation({
  args: {
    jobId: v.id("preparationJobs"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Preparation job not found")
    const now = Date.now()
    requireLiveLease(job, boundedId(args.leaseToken, "Lease token"), now)
    const safeError = boundedId(args.error, "Preparation error", 500)
    await ctx.db.patch(args.jobId, {
      status: "failed",
      lastError: safeError,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
    await ctx.db.patch(job.sourceId, {
      status: "failed",
      error: safeError,
    })
    return {
      jobId: args.jobId,
      status: "failed" as const,
      nextChunkOrdinal: job.nextChunkOrdinal,
    }
  },
})

/** Requeues a failed or expired job without discarding completed checkpoints. */
export const retry = mutation({
  args: { jobId: v.id("preparationJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Preparation job not found")
    const now = Date.now()
    if (job.status === "completed")
      throw new Error("Completed preparation cannot be retried")
    if (job.status === "leased" && (job.leaseExpiresAt ?? 0) > now)
      throw new Error("Active preparation lease cannot be retried")
    await ctx.db.patch(args.jobId, {
      status: "queued",
      lastError: undefined,
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    })
    await ctx.db.patch(job.sourceId, {
      status: "processing",
      error: undefined,
    })
    return {
      jobId: args.jobId,
      status: "queued" as const,
      nextChunkOrdinal: job.nextChunkOrdinal,
    }
  },
})

/** Reads one job progress row for a local worker or diagnostic screen. */
export const getJob = query({
  args: { jobId: v.id("preparationJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) return null
    return {
      ...progressFor(job),
      sourceId: job.sourceId,
      error: job.lastError ?? null,
    }
  },
})

/** Lists preparation jobs for a project so source progress survives page reloads. */
export const listJobsForProject = query({
  args: {
    projectId: v.id("projects"),
    sourceIds: v.optional(v.array(v.id("sources"))),
  },
  handler: async (ctx, args) => {
    const sourceIds = args.sourceIds ?? []
    if (sourceIds.length > 20)
      throw new Error("Job status may include at most 20 sources")
    const jobs = (
      await Promise.all(
        sourceIds.map((sourceId) =>
          ctx.db
            .query("preparationJobs")
            .withIndex("by_project_source", (q) =>
              q.eq("projectId", args.projectId).eq("sourceId", sourceId)
            )
            .order("desc")
            .first()
        )
      )
    ).filter((job): job is NonNullable<typeof job> => job !== null)
    return jobs.map((job) => ({
      ...progressFor(job),
      sourceId: job.sourceId,
      error: job.lastError ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }))
  },
})
