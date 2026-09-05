/** Persists approval-first research proposals and leases planning work to the local Mac worker. */

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  buildResearchImportCheckpoint,
  researchImportPartMatchesSource,
  validateResearchImportPartSequence,
} from "../lib/research-import-checkpoint"

/** Maximum request text retained for one proposal. */
export const MAX_RESEARCH_REQUEST_LENGTH = 2_000
/** Maximum planner lease duration. */
export const RESEARCH_PROPOSAL_LEASE_MS = 5 * 60 * 1_000
/** Maximum queued proposals inspected by one claim. */
const CLAIM_SCAN_LIMIT = 50

/** Lease duration for one selected-source import. */
export const RESEARCH_IMPORT_LEASE_MS = 5 * 60 * 1_000
/** Maximum activity records retained for one proposal. */
const MAX_RESEARCH_ACTIVITY_EVENTS = 32

/** Stable source-import failure categories retained for client recovery copy. */
type ResearchImportFailureCategory =
  | "site-refused"
  | "not-found"
  | "unsupported-format"
  | "needs-ocr"
  | "too-large"
  | "timeout"
  | "invalid-url"
  | "download-failed"

/** Converts a safe category into fixed user-facing recovery text. */
function importFailureMessage(category: ResearchImportFailureCategory): string {
  switch (category) {
    case "site-refused":
      return "The source site refused the download. Choose another public source."
    case "not-found":
      return "The approved source was not found. Choose another source."
    case "unsupported-format":
      return "This source format is not supported for automatic import."
    case "needs-ocr":
      return "This PDF has no extractable text and needs OCR."
    case "too-large":
      return "This source is too large to import."
    case "timeout":
      return "The source request timed out. Retry later."
    case "invalid-url":
      return "The approved source URL is invalid or no longer safe."
    case "download-failed":
      return "The source could not be downloaded. Retry later."
  }
}

/** Validates one persisted source suggestion shape before storage. */
const sourceValidator = v.object({
  url: v.string(),
  title: v.string(),
  reason: v.string(),
  verification: v.union(
    v.literal("suggested-unverified"),
    v.literal("checked")
  ),
})

/** Validates one planned generated-note outline shape before storage. */
const generatedNoteValidator = v.object({
  label: v.literal("generated"),
  title: v.string(),
  description: v.string(),
  reason: v.string(),
})

/** Validator shared by the worker completion mutation and generated proposal data. */
const proposalValidator = v.object({
  scope: v.string(),
  topics: v.array(v.string()),
  sources: v.array(sourceValidator),
  generatedNotes: v.array(generatedNoteValidator),
})

/** Safe lifecycle event accepted from the local research worker. */
const activityEventValidator = v.object({
  stage: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("searching"),
    v.literal("synthesizing"),
    v.literal("completed"),
    v.literal("failed")
  ),
  label: v.optional(v.string()),
  query: v.optional(v.string()),
  tool: v.optional(v.literal("web_search")),
  occurredAt: v.number(),
  elapsedMs: v.number(),
})

/** Bounds a required text value and returns its trimmed form. */
function boundedText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > maximum) throw new Error(`${label} is too long`)
  return trimmed
}

/** Finds a project-owned research proposal by its client request id. */
async function findProposal(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  requestId: string
): Promise<Doc<"researchProposals"> | null> {
  const rows = await ctx.db
    .query("researchProposals")
    .withIndex("by_project_requestId", (q) =>
      q.eq("projectId", projectId).eq("requestId", requestId)
    )
    .take(1)
  return rows[0] ?? null
}

/** Validates bounded fields from a generated proposal before atomic persistence. */
function validateProposal(value: {
  scope: string
  topics: readonly string[]
  sources: readonly {
    url: string
    title: string
    reason: string
    verification: "suggested-unverified" | "checked"
  }[]
  generatedNotes: readonly {
    label: "generated"
    title: string
    description: string
    reason: string
  }[]
}): void {
  boundedText(value.scope, "Proposal scope", 3_000)
  if (!value.topics.length || value.topics.length > 12)
    throw new Error("Proposal topics are invalid")
  const topics = value.topics.map((topic) =>
    boundedText(topic, "Topic", 180).toLowerCase()
  )
  if (new Set(topics).size !== topics.length)
    throw new Error("Proposal topics must be unique")
  if (value.sources.length > 20) throw new Error("Proposal sources are invalid")
  const urls = value.sources.map((source) => {
    const url = boundedText(source.url, "Source URL", 2_048)
    boundedText(source.title, "Source title", 240)
    boundedText(source.reason, "Source reason", 600)
    if (source.verification !== "suggested-unverified")
      throw new Error("Proposal sources must remain unverified")
    return url
  })
  if (new Set(urls).size !== urls.length)
    throw new Error("Proposal source URLs must be unique")
  if (value.generatedNotes.length > 12)
    throw new Error("Generated note plans are invalid")
  for (const note of value.generatedNotes) {
    if (note.label !== "generated")
      throw new Error("Generated note label is required")
    boundedText(note.title, "Generated note title", 240)
    boundedText(note.description, "Generated note description", 800)
    boundedText(note.reason, "Generated note reason", 600)
  }
}

/** Returns proposal data safe for polling clients and excludes lease credentials. */
function proposalForClient(proposal: Doc<"researchProposals">) {
  return {
    proposalId: proposal._id,
    projectId: proposal.projectId,
    requestId: proposal.requestId,
    request: proposal.request,
    status: proposal.status,
    ...(proposal.status === "ready"
      ? {
          proposal: {
            scope: proposal.scope,
            topics: proposal.topics,
            sources: proposal.sources,
            generatedNotes: proposal.generatedNotes,
          },
        }
      : { proposal: null }),
    ...(proposal.lastError === undefined ? {} : { error: proposal.lastError }),
    activity: proposal.activity ?? [],
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  }
}

/** Enqueues one approval-first planning request idempotently for a project. */
export const enqueue = mutation({
  args: {
    projectId: v.id("projects"),
    requestId: v.string(),
    request: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const requestId = boundedText(args.requestId, "Request id", 200)
    const request = boundedText(
      args.request,
      "Research request",
      MAX_RESEARCH_REQUEST_LENGTH
    )
    const existing = await findProposal(ctx, args.projectId, requestId)
    if (existing) {
      if (existing.request !== request)
        throw new Error("Request id payload conflicts with stored proposal")
      return { ...proposalForClient(existing), alreadyQueued: true }
    }
    const now = Date.now()
    const proposalId = await ctx.db.insert("researchProposals", {
      projectId: args.projectId,
      requestId,
      request,
      status: "queued",
      scope: "",
      topics: [],
      sources: [],
      generatedNotes: [],
      activity: [
        {
          stage: "queued" as const,
          label: "Research queued",
          occurredAt: now,
          elapsedMs: 0,
        },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const proposal = await ctx.db.get(proposalId)
    if (!proposal) throw new Error("Research proposal could not be created")
    return { ...proposalForClient(proposal), alreadyQueued: false }
  },
})

/** Returns one proposal by project and request id without any imported source content. */
export const get = query({
  args: { projectId: v.id("projects"), requestId: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const proposal = await findProposal(
      ctx,
      args.projectId,
      boundedText(args.requestId, "Request id", 200)
    )
    return proposal ? proposalForClient(proposal) : null
  },
})

/** Lists recent proposals for project reloads without returning source content. */
export const listForProject = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const limit = args.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error("Proposal limit must be between 1 and 20")
    const proposals = await ctx.db
      .query("researchProposals")
      .withIndex("by_project_createdAt", (q) =>
        q.eq("projectId", args.projectId)
      )
      .order("desc")
      .take(limit)
    return proposals.map(proposalForClient)
  },
})

/** Claims the oldest queued or expired planning request for a local worker. */
export const claimNext = mutation({
  args: { workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const workerId = boundedText(args.workerId, "Worker id", 200)
    const leaseToken = boundedText(args.leaseToken, "Lease token", 200)
    const now = Date.now()
    const queued = await ctx.db
      .query("researchProposals")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const running = await ctx.db
      .query("researchProposals")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const candidate = [...queued, ...running]
      .filter(
        (proposal) =>
          proposal.status === "queued" ||
          (proposal.leaseExpiresAt !== undefined &&
            proposal.leaseExpiresAt <= now)
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0]
    if (!candidate) return null
    const leaseExpiresAt = now + RESEARCH_PROPOSAL_LEASE_MS
    await ctx.db.patch(candidate._id, {
      status: "running",
      workerId,
      leaseToken,
      leaseExpiresAt,
      lastError: undefined,
      activity: [
        ...(candidate.activity ?? []),
        {
          stage: "running" as const,
          label: "Research started",
          occurredAt: now,
          elapsedMs: Math.max(0, now - candidate.createdAt),
        },
      ].slice(-MAX_RESEARCH_ACTIVITY_EVENTS),
      updatedAt: now,
    })
    return {
      proposalId: candidate._id,
      projectId: candidate.projectId,
      requestId: candidate.requestId,
      request: candidate.request,
      leaseToken,
    }
  },
})

/** Appends one bounded observable activity event while a proposal lease is live. */
export const recordActivity = mutation({
  args: {
    proposalId: v.id("researchProposals"),
    leaseToken: v.string(),
    event: activityEventValidator,
  },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId)
    if (
      !proposal ||
      proposal.status !== "running" ||
      proposal.leaseToken !== args.leaseToken ||
      (proposal.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Research proposal lease is missing or expired")
    if (args.event.label !== undefined && args.event.label.length > 120)
      throw new Error("Research activity label is too long")
    if (args.event.query !== undefined && args.event.query.length > 500)
      throw new Error("Research activity query is too long")
    if (
      !Number.isSafeInteger(args.event.occurredAt) ||
      args.event.occurredAt < 0
    )
      throw new Error("Research activity timestamp is invalid")
    if (!Number.isSafeInteger(args.event.elapsedMs) || args.event.elapsedMs < 0)
      throw new Error("Research activity elapsed time is invalid")
    const activity = [...(proposal.activity ?? []), args.event].slice(
      -MAX_RESEARCH_ACTIVITY_EVENTS
    )
    await ctx.db.patch(proposal._id, { activity, updatedAt: Date.now() })
    return { status: "recorded" as const }
  },
})

/** Commits one validated proposal and clears its worker lease atomically. */
export const complete = mutation({
  args: {
    proposalId: v.id("researchProposals"),
    leaseToken: v.string(),
    proposal: proposalValidator,
  },
  handler: async (ctx, args) => {
    validateProposal(args.proposal)
    const proposal = await ctx.db.get(args.proposalId)
    if (
      !proposal ||
      proposal.status !== "running" ||
      proposal.leaseToken !== args.leaseToken ||
      (proposal.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Research proposal lease is missing or expired")
    await ctx.db.patch(proposal._id, {
      status: "ready",
      scope: args.proposal.scope.trim(),
      topics: args.proposal.topics.map((topic) => topic.trim()),
      sources: args.proposal.sources.map((source) => ({
        ...source,
        verification: "suggested-unverified" as const,
      })),
      generatedNotes: args.proposal.generatedNotes.map((note) => ({
        ...note,
        label: "generated" as const,
      })),
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      updatedAt: Date.now(),
    })
    return { status: "ready" as const }
  },
})

/** Records a generic failure while preserving the request for deliberate retry. */
export const fail = mutation({
  args: {
    proposalId: v.id("researchProposals"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.proposalId)
    if (
      !proposal ||
      proposal.status !== "running" ||
      proposal.leaseToken !== args.leaseToken ||
      (proposal.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Research proposal lease is missing or expired")
    void args.error
    const safeError =
      "Research proposal could not be prepared. Retry to try again."
    await ctx.db.patch(proposal._id, {
      status: "failed",
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastError: safeError,
      updatedAt: Date.now(),
    })
    return { status: "failed" as const }
  },
})

/** Requeues one failed proposal only after an explicit retry action. */
export const retry = mutation({
  args: { projectId: v.id("projects"), requestId: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const proposal = await findProposal(
      ctx,
      args.projectId,
      boundedText(args.requestId, "Request id", 200)
    )
    if (!proposal) throw new Error("Research proposal was not found")
    if (proposal.status !== "failed")
      throw new Error("Only failed proposals can be retried")
    await ctx.db.patch(proposal._id, {
      status: "queued",
      lastError: undefined,
      updatedAt: Date.now(),
    })
    return { status: "queued" as const }
  },
})

/** Returns one selected source import in a client-safe progress shape. */
function importForClient(importRow: Doc<"researchProposalImports">) {
  return {
    importId: importRow._id,
    proposalId: importRow.proposalId,
    sourceIndex: importRow.sourceIndex,
    status: importRow.status,
    ...(importRow.sourceId === undefined
      ? {}
      : { sourceId: importRow.sourceId }),
    ...(importRow.preparationJobId === undefined
      ? {}
      : { preparationJobId: importRow.preparationJobId }),
    ...(importRow.partCount === undefined
      ? {}
      : {
          partCount: importRow.partCount,
          completedPartCount: importRow.completedPartCount ?? 0,
          partSourceIds: importRow.partSourceIds ?? [],
          partPreparationJobIds: importRow.partPreparationJobIds ?? [],
        }),
    ...(importRow.lastError === undefined
      ? {}
      : { error: importRow.lastError }),
    ...(importRow.failureCategory === undefined
      ? {}
      : { failureCategory: importRow.failureCategory }),
    createdAt: importRow.createdAt,
    updatedAt: importRow.updatedAt,
  }
}

/** Loads a ready proposal for an apply action and verifies its project owner. */
async function requireReadyProposal(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  requestId: string
): Promise<Doc<"researchProposals">> {
  const proposal = await findProposal(ctx, projectId, requestId)
  if (!proposal) throw new Error("Research proposal was not found")
  if (proposal.status !== "ready")
    throw new Error("Research proposal is not ready to apply")
  return proposal
}

/** Enqueues selected source indexes from a stored ready proposal idempotently. */
export const apply = mutation({
  args: {
    projectId: v.id("projects"),
    requestId: v.string(),
    sourceIndexes: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    const proposal = await requireReadyProposal(
      ctx,
      args.projectId,
      boundedText(args.requestId, "Request id", 200)
    )
    if (!args.sourceIndexes.length || args.sourceIndexes.length > 20)
      throw new Error("Select between 1 and 20 proposal sources")
    const indexes = Array.from(new Set(args.sourceIndexes))
    if (
      indexes.length !== args.sourceIndexes.length ||
      indexes.some(
        (index) =>
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= proposal.sources.length
      )
    )
      throw new Error("Selected source index is invalid")
    const now = Date.now()
    const imports: Doc<"researchProposalImports">[] = []
    for (const sourceIndex of indexes) {
      const existing = await ctx.db
        .query("researchProposalImports")
        .withIndex("by_proposal_sourceIndex", (q) =>
          q.eq("proposalId", proposal._id).eq("sourceIndex", sourceIndex)
        )
        .take(1)
      if (existing[0]) {
        const existingImport = existing[0]
        if (existingImport.status === "failed") {
          await ctx.db.patch(existingImport._id, {
            status: "queued",
            workerId: undefined,
            leaseToken: undefined,
            leaseExpiresAt: undefined,
            failureCategory: undefined,
            lastError: undefined,
            updatedAt: now,
          })
          const requeued = await ctx.db.get(existingImport._id)
          if (!requeued)
            throw new Error("Research source import could not be requeued")
          imports.push(requeued)
        } else {
          imports.push(existingImport)
        }
        continue
      }
      const importId = await ctx.db.insert("researchProposalImports", {
        proposalId: proposal._id,
        projectId: args.projectId,
        sourceIndex,
        status: "queued",
        failureCategory: undefined,
        createdAt: now,
        updatedAt: now,
      })
      const importRow = await ctx.db.get(importId)
      if (!importRow)
        throw new Error("Research source import could not be queued")
      imports.push(importRow)
    }
    return {
      proposalId: proposal._id,
      imports: imports.map(importForClient),
    }
  },
})

/** Lists selected-source progress for a proposal reload screen. */
export const listImports = query({
  args: { projectId: v.id("projects"), requestId: v.string() },
  handler: async (ctx, args) => {
    const proposal = await findProposal(
      ctx,
      args.projectId,
      boundedText(args.requestId, "Request id", 200)
    )
    if (!proposal) return []
    const imports = await ctx.db
      .query("researchProposalImports")
      .withIndex("by_proposal_sourceIndex", (q) =>
        q.eq("proposalId", proposal._id)
      )
      .order("asc")
      .collect()
    return imports.map(importForClient)
  },
})

/** Claims one queued or expired selected-source import for the local worker. */
export const claimNextImport = mutation({
  args: { workerId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const workerId = boundedText(args.workerId, "Worker id", 200)
    const leaseToken = boundedText(args.leaseToken, "Lease token", 200)
    const now = Date.now()
    const queued = await ctx.db
      .query("researchProposalImports")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const running = await ctx.db
      .query("researchProposalImports")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .order("asc")
      .take(CLAIM_SCAN_LIMIT)
    const candidate = [...queued, ...running]
      .filter(
        (row) =>
          row.status === "queued" ||
          (row.leaseExpiresAt !== undefined && row.leaseExpiresAt <= now)
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0]
    if (!candidate) return null
    const proposal = await ctx.db.get(candidate.proposalId)
    if (!proposal || proposal.status !== "ready") return null
    const source = proposal.sources[candidate.sourceIndex]
    if (!source)
      throw new Error("Selected proposal source is no longer available")
    const leaseExpiresAt = now + RESEARCH_IMPORT_LEASE_MS
    await ctx.db.patch(candidate._id, {
      status: "running",
      workerId,
      leaseToken,
      leaseExpiresAt,
      failureCategory: undefined,
      lastError: undefined,
      updatedAt: now,
    })
    return {
      importId: candidate._id,
      proposalId: proposal._id,
      projectId: proposal.projectId,
      sourceIndex: candidate.sourceIndex,
      source,
      leaseToken,
    }
  },
})

/** Atomically persists a fetched source and queues its preparation job. */
export const completeImport = mutation({
  args: {
    importId: v.id("researchProposalImports"),
    leaseToken: v.string(),
    filename: v.string(),
    kind: v.union(
      v.literal("pdf"),
      v.literal("markdown"),
      v.literal("text"),
      v.literal("paste")
    ),
    extractedText: v.string(),
    originalUrl: v.string(),
    partNumber: v.optional(v.number()),
    totalParts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.importId)
    if (
      row?.status === "imported" &&
      row.sourceId &&
      row.preparationJobId &&
      row.partSourceIds === undefined
    )
      return {
        status: "imported" as const,
        sourceId: row.sourceId,
        preparationJobId: row.preparationJobId,
      }
    const completedMultipartImport =
      row?.status === "imported" && row.partSourceIds !== undefined
    if (
      !row ||
      (!completedMultipartImport && row.status !== "running") ||
      (!completedMultipartImport &&
        (row.leaseToken !== args.leaseToken ||
          (row.leaseExpiresAt ?? 0) <= Date.now()))
    )
      throw new Error("Research import lease is missing or expired")
    const proposal = await ctx.db.get(row.proposalId)
    if (
      !proposal ||
      proposal.projectId !== row.projectId ||
      proposal.status !== "ready"
    )
      throw new Error("Research proposal is no longer ready")
    const sourceSuggestion = proposal.sources[row.sourceIndex]
    if (!sourceSuggestion || sourceSuggestion.url !== args.originalUrl)
      throw new Error("Fetched source does not match the approved proposal")
    const filename = boundedText(args.filename, "Filename", 255)
    const extractedText = boundedText(
      args.extractedText,
      "Extracted text",
      120_000
    )
    const originalUrl = boundedText(args.originalUrl, "Source URL", 2_048)
    const partNumber = args.partNumber ?? 1
    const totalParts = args.totalParts ?? 1
    const existingPartSourceIds = row.partSourceIds ?? []
    const existingPartJobIds = row.partPreparationJobIds ?? []
    validateResearchImportPartSequence({
      existingPartCount: existingPartSourceIds.length,
      partNumber,
      totalParts,
    })
    if (
      (row.partCount !== undefined && row.partCount !== totalParts) ||
      (row.partCount === undefined && partNumber !== 1) ||
      existingPartSourceIds.length !== existingPartJobIds.length
    )
      throw new Error("Research import part checkpoint is invalid")
    if (
      existingPartSourceIds.length >= partNumber &&
      existingPartJobIds.length >= partNumber
    ) {
      const existingSource = await ctx.db.get(
        existingPartSourceIds[partNumber - 1]
      )
      if (
        !researchImportPartMatchesSource({
          existingSource,
          filename,
          kind: args.kind,
          extractedText,
          originalUrl,
        })
      )
        throw new Error("Research import part changed during retry")
      return {
        status: "partially_imported" as const,
        sourceId: existingPartSourceIds[partNumber - 1],
        preparationJobId: existingPartJobIds[partNumber - 1],
      }
    }
    const now = Date.now()
    const sourceId = await ctx.db.insert("sources", {
      projectId: row.projectId,
      filename,
      kind: args.kind,
      extractedText,
      originalUrl,
      status: "processing",
      createdAt: now,
    })
    const preparationJobId = await ctx.db.insert("preparationJobs", {
      projectId: row.projectId,
      sourceId,
      sourceTextSnapshot: extractedText,
      sourceFilename: filename,
      sourceKind: args.kind,
      status: "queued",
      nextChunkOrdinal: 0,
      learningScope: proposal.scope,
      generatedItemCount: 0,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    const checkpoint = buildResearchImportCheckpoint({
      existingSourceIds: existingPartSourceIds,
      existingPreparationJobIds: existingPartJobIds,
      sourceId,
      preparationJobId,
      totalParts,
    })
    const completedPartCount = checkpoint.sourceIds.length
    await ctx.db.patch(row._id, {
      status: checkpoint.status,
      ...(row.sourceId === undefined ? { sourceId } : {}),
      ...(row.preparationJobId === undefined ? { preparationJobId } : {}),
      partCount: totalParts,
      completedPartCount,
      partSourceIds: checkpoint.sourceIds,
      partPreparationJobIds: checkpoint.preparationJobIds,
      ...(checkpoint.clearLease
        ? {
            workerId: undefined,
            leaseToken: undefined,
            leaseExpiresAt: undefined,
          }
        : {}),
      failureCategory: undefined,
      lastError: undefined,
      updatedAt: now,
    })
    return { status: "imported" as const, sourceId, preparationJobId }
  },
})

/** Records a generic selected-source failure for deliberate retry. */
export const failImport = mutation({
  args: {
    importId: v.id("researchProposalImports"),
    leaseToken: v.string(),
    failureCategory: v.union(
      v.literal("site-refused"),
      v.literal("not-found"),
      v.literal("unsupported-format"),
      v.literal("needs-ocr"),
      v.literal("too-large"),
      v.literal("timeout"),
      v.literal("invalid-url"),
      v.literal("download-failed")
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.importId)
    if (
      !row ||
      row.status !== "running" ||
      row.leaseToken !== args.leaseToken ||
      (row.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw new Error("Research import lease is missing or expired")
    await ctx.db.patch(row._id, {
      status: "failed",
      workerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      failureCategory: args.failureCategory,
      lastError: importFailureMessage(args.failureCategory),
      updatedAt: Date.now(),
    })
    return { status: "failed" as const }
  },
})

/** Requeues one failed selected-source import after an explicit retry action. */
export const retryImport = mutation({
  args: {
    projectId: v.id("projects"),
    requestId: v.string(),
    sourceIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const proposal = await requireReadyProposal(
      ctx,
      args.projectId,
      boundedText(args.requestId, "Request id", 200)
    )
    if (!Number.isSafeInteger(args.sourceIndex) || args.sourceIndex < 0)
      throw new Error("Source index is invalid")
    const rows = await ctx.db
      .query("researchProposalImports")
      .withIndex("by_proposal_sourceIndex", (q) =>
        q.eq("proposalId", proposal._id).eq("sourceIndex", args.sourceIndex)
      )
      .take(1)
    const row = rows[0]
    if (!row) throw new Error("Source import was not found")
    if (row.status !== "failed")
      throw new Error("Only failed source imports can be retried")
    await ctx.db.patch(row._id, {
      status: "queued",
      failureCategory: undefined,
      lastError: undefined,
      updatedAt: Date.now(),
    })
    return { status: "queued" as const }
  },
})
