/** Persists extracted sources and tracks their generation lifecycle. */

import { paginationOptsValidator } from "convex/server"
import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { sourceImportFingerprint } from "../lib/source-fingerprint"
import { resolveQueuedAiSelection } from "./ai_provider_settings"

/** Validator for source formats accepted by the extraction interface. */
const sourceKind = v.union(
  v.literal("pdf"),
  v.literal("markdown"),
  v.literal("text"),
  v.literal("paste")
)
/** Validator for the three reachable generation states. */
const sourceStatus = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed")
)

/** Maximum text accepted in one persisted source part. */
export const MAX_SOURCE_TEXT_LENGTH = 120_000

/** Supported source input shape shared by source creation mutations. */
type SourceCreateInput = {
  projectId: Id<"projects">
  filename: string
  kind: "pdf" | "markdown" | "text" | "paste"
  extractedText: string
  originalUrl?: string
}

/** Normalized source fields used for fingerprinting and persistence. */
type NormalizedSourceInput = SourceCreateInput

/** Read context required while validating and deduplicating a source input. */
type SourceWriteContext = Pick<QueryCtx, "db">

/** Validates one source input and returns normalized values for persistence. */
async function validateSourceInput(
  ctx: SourceWriteContext,
  args: SourceCreateInput
): Promise<NormalizedSourceInput> {
  if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found")
  const filename = args.filename.trim()
  const extractedText = args.extractedText.trim()
  if (!filename) throw new Error("Filename is required")
  if (filename.length > 255) throw new Error("Filename is too long")
  if (!extractedText) throw new Error("Source text is required")
  if (extractedText.length > MAX_SOURCE_TEXT_LENGTH)
    throw new Error("Source text is too large")
  const originalUrl = args.originalUrl?.trim() || undefined
  if (originalUrl !== undefined) {
    if (originalUrl.length > 2_048) throw new Error("Source URL is too long")
    let parsedUrl: URL
    try {
      parsedUrl = new URL(originalUrl)
    } catch {
      throw new Error("Source URL is invalid")
    }
    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username ||
      parsedUrl.password
    )
      throw new Error("Source URL must be a public HTTP(S) URL")
  }
  return { ...args, filename, extractedText, originalUrl }
}

/** Finds an exact source match through its durable project fingerprint index. */
async function findMatchingSource(
  ctx: SourceWriteContext,
  input: NormalizedSourceInput
) {
  const importFingerprint = sourceImportFingerprint({
    filename: input.filename,
    kind: input.kind,
    text: input.extractedText,
    originalUrl: input.originalUrl,
  })
  const candidates = await ctx.db
    .query("sources")
    .withIndex("by_project_fingerprint", (q) =>
      q
        .eq("projectId", input.projectId)
        .eq("importFingerprint", importFingerprint)
    )
    .take(2)
  const source = candidates.find(
    (candidate) =>
      candidate.filename === input.filename &&
      candidate.kind === input.kind &&
      candidate.extractedText === input.extractedText &&
      candidate.originalUrl === input.originalUrl
  )
  return { source, importFingerprint }
}

/** Lists a bounded page of source metadata attached to a project, newest first. */
export const listSources = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.paginationOpts.numItems > 20)
      throw new Error("Source pages may contain at most 20 items")
    const page = await ctx.db
      .query("sources")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate(args.paginationOpts)

    return {
      ...page,
      page: page.page.map((source) => {
        // The project view needs status and summaries, not the original upload.
        return Object.fromEntries(
          Object.entries(source).filter(([key]) => key !== "extractedText")
        ) as Omit<typeof source, "extractedText">
      }),
    }
  },
})

/** Creates a processing source after validating its parent and bounded content. */
export const createSource = mutation({
  args: {
    projectId: v.id("projects"),
    filename: v.string(),
    kind: sourceKind,
    extractedText: v.string(),
    originalUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const input = await validateSourceInput(ctx, args)
    const { source: existing, importFingerprint } = await findMatchingSource(
      ctx,
      input
    )
    if (existing) return existing._id
    return ctx.db.insert("sources", {
      projectId: args.projectId,
      filename: input.filename,
      kind: args.kind,
      extractedText: input.extractedText,
      ...(input.originalUrl ? { originalUrl: input.originalUrl } : {}),
      importFingerprint,
      status: "processing",
      createdAt: Date.now(),
    })
  },
})

/** Atomically creates one source part and its preparation job for new uploads. */
export const createAndEnqueue = mutation({
  args: {
    projectId: v.id("projects"),
    filename: v.string(),
    kind: sourceKind,
    extractedText: v.string(),
    originalUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const input = await validateSourceInput(ctx, args)
    const { source: existing, importFingerprint } = await findMatchingSource(
      ctx,
      input
    )
    let sourceId = existing?._id
    if (!sourceId) {
      sourceId = await ctx.db.insert("sources", {
        projectId: args.projectId,
        filename: input.filename,
        kind: args.kind,
        extractedText: input.extractedText,
        ...(input.originalUrl ? { originalUrl: input.originalUrl } : {}),
        importFingerprint,
        status: "processing",
        createdAt: Date.now(),
      })
    }
    const existingJob = await ctx.db
      .query("preparationJobs")
      .withIndex("by_project_source", (q) =>
        q.eq("projectId", args.projectId).eq("sourceId", sourceId!)
      )
      .first()
    if (existingJob?.status === "failed") {
      // Re-uploading the same part is an explicit retry, preserving saved sections.
      await ctx.db.patch(existingJob._id, {
        status: "queued",
        lastError: undefined,
        workerId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      })
      await ctx.db.patch(sourceId, { status: "processing", error: undefined })
      return {
        sourceId,
        jobId: existingJob._id,
        status: "queued" as const,
        alreadyQueued: true,
      }
    }
    if (existingJob)
      return {
        sourceId,
        jobId: existingJob._id,
        status: existingJob.status,
        alreadyQueued: true,
      }
    const selection = await resolveQueuedAiSelection(ctx, "cardGeneration")
    const now = Date.now()
    const jobId = await ctx.db.insert("preparationJobs", {
      projectId: args.projectId,
      sourceId,
      sourceTextSnapshot: input.extractedText,
      sourceFilename: input.filename,
      sourceKind: args.kind,
      status: "queued",
      nextChunkOrdinal: 0,
      providerId: selection.providerId,
      generationModel: selection.model,
      generationEffort: selection.effort,
      generatedItemCount: 0,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    if (existing)
      await ctx.db.patch(sourceId, { status: "processing", error: undefined })
    return {
      sourceId,
      jobId,
      status: "queued" as const,
      alreadyQueued: false,
    }
  },
})

/** Creates an original-file record and durable ingestion job after filesystem commit. */
export const createOriginalSource = mutation({
  args: {
    projectId: v.id("projects"),
    /** Unit the upload belongs to; must be in the same project. */
    unitId: v.optional(v.id("units")),
    /** Public page a fetched link source came from. */
    originalUrl: v.optional(v.string()),
    filename: v.string(),
    kind: sourceKind,
    relativeKey: v.string(),
    mimeType: v.optional(v.string()),
    sizeBytes: v.number(),
    contentHash: v.string(),
    unsupported: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    if (!args.relativeKey.startsWith("Sources/") || args.sizeBytes < 1)
      throw new Error("Original source metadata is invalid")
    if (args.unitId) {
      const unit = await ctx.db.get(args.unitId)
      if (!unit || unit.projectId !== args.projectId)
        throw new Error("Unit belongs to another project")
    }
    const duplicate = await ctx.db
      .query("sources")
      .withIndex("by_project_contentHash", (q) =>
        q.eq("projectId", args.projectId).eq("contentHash", args.contentHash)
      )
      .first()
    if (duplicate) {
      const job = await ctx.db
        .query("ingestionJobs")
        .withIndex("by_source", (q) => q.eq("sourceId", duplicate._id))
        .first()
      if (
        job &&
        job.status !== "completed" &&
        !(job.status === "running" && (job.leaseExpiresAt ?? 0) > Date.now())
      ) {
        await ctx.db.patch(job._id, {
          status: "queued",
          error: undefined,
          updatedAt: Date.now(),
        })
        await ctx.db.patch(duplicate._id, {
          status: "processing",
          error: undefined,
        })
        return {
          sourceId: duplicate._id,
          ingestionJobId: job._id,
          ingestionStatus: "queued" as const,
          duplicate: false,
        }
      }
      return {
        sourceId: duplicate._id,
        ingestionJobId: job?._id,
        unsupported: duplicate.unsupported,
        ...(job?.status ? { ingestionStatus: job.status } : {}),
        ...(job?.leaseExpiresAt !== undefined
          ? { ingestionLeaseExpiresAt: job.leaseExpiresAt }
          : {}),
        duplicate: true,
      }
    }
    const sourceId = await ctx.db.insert("sources", {
      projectId: args.projectId,
      ...(args.unitId ? { unitId: args.unitId } : {}),
      ...(args.originalUrl && /^https?:\/\//i.test(args.originalUrl)
        ? { originalUrl: args.originalUrl.slice(0, 2_000) }
        : {}),
      filename: args.filename.trim().slice(0, 255),
      kind: args.kind,
      extractedText: "",
      relativeKey: args.relativeKey,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      contentHash: args.contentHash,
      unsupported: args.unsupported,
      status: "processing",
      createdAt: Date.now(),
    })
    const ingestionJobId = await ctx.db.insert("ingestionJobs", {
      projectId: args.projectId,
      sourceId,
      status: "queued",
      sourceHash: args.contentHash,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return {
      sourceId,
      ingestionJobId,
      ingestionStatus: "queued" as const,
      duplicate: false,
    }
  },
})

/** Lists a bounded page of queued or interrupted original ingestions for the local worker. */
export const listPendingOriginalIngestions = query({
  args: {},
  handler: async (ctx) => {
    const queued = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .take(20)
    const running = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .take(20)
    return [
      ...queued,
      ...running.filter((job) => (job.leaseExpiresAt ?? 0) <= Date.now()),
    ]
      .slice(0, 20)
      .map((job) => ({ projectId: job.projectId, sourceId: job.sourceId }))
  },
})

/** Claims one ingestion operation; an expired worker cannot overwrite its replacement. */
export const claimOriginalIngestion = mutation({
  args: { ingestionJobId: v.id("ingestionJobs"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.ingestionJobId)
    if (!job || job.status === "completed" || job.status === "failed")
      return false
    if (job.status === "running" && (job.leaseExpiresAt ?? 0) > Date.now())
      return false
    await ctx.db.patch(job._id, {
      status: "running",
      leaseToken: args.leaseToken,
      leaseExpiresAt: Date.now() + 300_000,
      updatedAt: Date.now(),
    })
    return true
  },
})

/** Returns original source metadata for a project scoped retry route. */
export const getOriginalSource = query({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source || source.projectId !== args.projectId) return null
    const ingestionJob = await ctx.db
      .query("ingestionJobs")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .first()
    return {
      relativeKey: source.relativeKey,
      filename: source.filename,
      mimeType: source.mimeType,
      contentHash: source.contentHash,
      status: source.status,
      hasExtractedText: Boolean(source.extractedText.trim()),
      extractedText: source.extractedText,
      kind: source.kind,
      ingestionJobId: ingestionJob?._id,
      ingestionStatus: ingestionJob?.status,
      ingestionLeaseExpiresAt: ingestionJob?.leaseExpiresAt,
    }
  },
})

/** Returns one complete source record for preview, overview, and inspection. */
export const getSource = query({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source || source.projectId !== args.projectId) return null
    return source
  },
})

/** Completes or fails deterministic original-file extraction and records bounded text. */
export const completeOriginalIngestion = mutation({
  args: {
    sourceId: v.id("sources"),
    ingestionJobId: v.id("ingestionJobs"),
    leaseToken: v.string(),
    extractedText: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    unsupported: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    const job = await ctx.db.get(args.ingestionJobId)
    if (!source || !job || job.sourceId !== source._id)
      throw new Error("Ingestion job is invalid")
    if (
      job.leaseToken !== args.leaseToken ||
      (job.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Ingestion lease expired")
    if (args.status === "completed") {
      if (!args.unsupported && (
        !args.extractedText.trim() ||
        new TextEncoder().encode(args.extractedText).byteLength > 500_000
      )) throw new Error("Extracted source text is empty or exceeds 500 KB")
    }
    await ctx.db.patch(source._id, {
      extractedText: args.extractedText,
      // Teach reads extracted text directly, so a source is usable as soon as
      // extraction finishes; there is no generation step to wait for.
      status: args.status === "completed" ? "ready" : "failed",
      unsupported: args.unsupported ?? false,
      error: args.error ? args.error.slice(0, 500) : undefined,
    })
    await ctx.db.patch(job._id, {
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      status: args.status,
      error: args.error ? args.error.slice(0, 500) : undefined,
      updatedAt: Date.now(),
    })
  },
})

/** Records a source result while bounding generated summaries and safe error details. */
export const updateSource = mutation({
  args: {
    sourceId: v.id("sources"),
    status: sourceStatus,
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source) throw new Error("Source not found")
    const summary = args.summary?.trim()
    const error = args.error?.trim()
    if (summary !== undefined && (!summary || summary.length > 1_000))
      throw new Error("Source summary is invalid")
    if (error !== undefined && (!error || error.length > 500))
      throw new Error("Source error is invalid")
    if (args.status === "ready" && !summary)
      throw new Error("Ready sources require a summary")
    if (args.status === "failed" && !error)
      throw new Error("Failed sources require an error")
    const patch: {
      status: typeof args.status
      summary?: string
      error?: string
    } = { status: args.status }
    if (summary !== undefined) patch.summary = summary
    if (error !== undefined) patch.error = error
    await ctx.db.patch(args.sourceId, patch)
    return args.sourceId
  },
})

/** Backward-compatible name used by older generated clients. */
export const updateSourceGenerationResult = updateSource
