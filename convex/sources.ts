/** Persists extracted sources and tracks their generation lifecycle. */

import { paginationOptsValidator } from "convex/server"
import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"
import { sourceImportFingerprint } from "../lib/source-fingerprint"

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
    const now = Date.now()
    const jobId = await ctx.db.insert("preparationJobs", {
      projectId: args.projectId,
      sourceId,
      sourceTextSnapshot: input.extractedText,
      sourceFilename: input.filename,
      sourceKind: args.kind,
      status: "queued",
      nextChunkOrdinal: 0,
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
