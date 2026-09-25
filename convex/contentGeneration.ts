/** Owns agent-led lesson jobs and imports validated page drafts into learning data. */

import { mutation, query } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import {
  DEFAULT_CONTENT_DEPTH,
  contentManifestSchema,
  contentDepth,
  validateLessonDraft,
} from "../lib/content-generation"
import { resolveQueuedContentSelection } from "./ai_provider_settings"

/** Long enough for one file-reading agent turn and bounded draft import. */
const LEASE_MS = 45 * 60_000

/** Saves the project's preference for future content jobs. */
export const setDepth = mutation({
  args: { projectId: v.id("projects"), depth: v.number() },
  handler: async (ctx, args) => {
    contentDepth(args.depth)
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    await ctx.db.patch(args.projectId, { contentDepth: args.depth })
  },
})

/** Queues a source once and resumes a failed job without changing its settings. */
export const enqueue = mutation({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId)
    const source = await ctx.db.get(args.sourceId)
    if (!project || !source || source.projectId !== args.projectId)
      throw new Error("Project source not found")
    const existing = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_project_source", (q) =>
        q.eq("projectId", args.projectId).eq("sourceId", args.sourceId)
      )
      .first()
    if (existing) {
      const resumable =
        existing.status === "failed" ||
        (existing.status === "leased" &&
          (existing.leaseExpiresAt ?? 0) <= Date.now())
      if (resumable) {
        await ctx.db.patch(existing._id, {
          status: "queued",
          error: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          updatedAt: Date.now(),
        })
        await ctx.db.patch(source._id, {
          status: "processing",
          error: undefined,
        })
      }
      return {
        jobId: existing._id,
        status: resumable ? ("queued" as const) : existing.status,
      }
    }
    const selection = await resolveQueuedContentSelection(ctx)
    const now = Date.now()
    const jobId = await ctx.db.insert("contentGenerationJobs", {
      projectId: args.projectId,
      sourceId: args.sourceId,
      status: "queued",
      depth: project.contentDepth ?? DEFAULT_CONTENT_DEPTH,
      providerId: selection.providerId,
      generationModel: selection.model,
      generationEffort: selection.effort,
      importedPages: 0,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(source._id, { status: "processing", error: undefined })
    return { jobId, status: "queued" as const }
  },
})

/** Returns visible agent job state beside the source inventory. */
export const listForProject = query({
  args: { projectId: v.id("projects"), sourceIds: v.array(v.id("sources")) },
  handler: async (ctx, args) => {
    if (args.sourceIds.length > 30) throw new Error("Too many source IDs")
    const now = Date.now()
    return (
      await Promise.all(
        args.sourceIds.map(async (sourceId) => {
          const job = await ctx.db
            .query("contentGenerationJobs")
            .withIndex("by_project_source", (q) =>
              q.eq("projectId", args.projectId).eq("sourceId", sourceId)
            )
            .first()
          return (
            job && {
              jobId: job._id,
              sourceId,
              status: job.status,
              error: job.error ?? null,
              totalPages: job.totalPages ?? null,
              importedPages: job.importedPages,
              includedSections:
                job.coverage?.filter((entry) => entry.status === "included")
                  .length ?? null,
              skippedSections:
                job.coverage?.filter((entry) => entry.status === "skipped")
                  .length ?? null,
              leaseExpired:
                job.status === "leased" && (job.leaseExpiresAt ?? 0) <= now,
            }
          )
        })
      )
    ).filter((job) => job !== null)
  },
})

/** Returns the saved source-section accounting for one completed or failed job. */
export const getCoverage = query({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_project_source", (q) =>
        q.eq("projectId", args.projectId).eq("sourceId", args.sourceId)
      )
      .first()
    return job?.coverage ?? null
  },
})

/** Claims the oldest available source while retaining its depth and provider snapshot. */
export const claimNext = mutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, args) => {
    if (!args.leaseToken.trim() || args.leaseToken.length > 128)
      throw new Error("Lease token is invalid")
    const now = Date.now()
    const queued = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .take(30)
    const expired = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "leased"))
      .take(30)
    const job = [
      ...queued,
      ...expired.filter((item) => (item.leaseExpiresAt ?? 0) <= now),
    ].sort((left, right) => left.createdAt - right.createdAt)[0]
    if (!job) return null
    const source = await ctx.db.get(job.sourceId)
    const project = await ctx.db.get(job.projectId)
    if (!source || !project) throw new Error("Content job source is missing")
    await ctx.db.patch(job._id, {
      status: "leased",
      leaseToken: args.leaseToken,
      leaseExpiresAt: now + LEASE_MS,
      updatedAt: now,
    })
    return {
      jobId: job._id,
      projectId: job.projectId,
      projectTitle: project.title,
      sourceId: source._id,
      filename: source.filename,
      sourceKind: source.kind,
      relativeKey: source.relativeKey ?? null,
      extractedText: source.extractedText,
      depth: job.depth,
      learningScope: job.learningScope ?? null,
      providerId: job.providerId ?? "codex",
      providerInstanceId: job.providerInstanceId ?? null,
      model: job.generationModel ?? null,
      effort: job.generationEffort ?? null,
      importedPages: job.importedPages,
      totalPages: job.totalPages ?? null,
    }
  },
})

/** Paginates current lesson and question context for agent source reconciliation. */
export const listExistingItems = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("learningItems")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .paginate(args.paginationOpts)
    const page = await Promise.all(
      result.page.map(async (item) => {
        if (item.archivedAt) return null
        const concept = await ctx.db.get(item.conceptId)
        const topic = concept?.topicId
          ? await ctx.db.get(concept.topicId)
          : null
        return {
          itemId: item._id,
          conceptId: item.conceptId,
          topicTitle: topic?.title ?? "Other material",
          conceptTitle: concept?.title ?? item.title,
          type: item.type,
          title: item.title,
          body: item.type === "explain" ? item.body : undefined,
          question: item.type === "explain" ? undefined : item.question,
          sourceIds: item.sourceIds,
        }
      })
    )
    return { ...result, page: page.filter((item) => item !== null) }
  },
})

/** Lists source identities that the agent may cite in a project. */
export const listSourceIdentity = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(1001)
    if (sources.length > 1000)
      throw new Error("Source inventory exceeds the content export limit")
    return sources.map((source) => ({
      id: source._id,
      filename: source.filename,
      relativeKey: source.relativeKey ?? null,
    }))
  },
})

/** Requires the current worker lease before any draft changes live learning data. */
function requireLease(
  job: Doc<"contentGenerationJobs">,
  leaseToken: string
): void {
  if (
    job.status !== "leased" ||
    job.leaseToken !== leaseToken ||
    (job.leaseExpiresAt ?? 0) <= Date.now()
  )
    throw new Error("Content generation lease expired")
}

/** Records a fully validated file count before importing any page. */
export const recordManifest = mutation({
  args: {
    jobId: v.id("contentGenerationJobs"),
    leaseToken: v.string(),
    manifest: v.any(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    const manifest = contentManifestSchema.parse(args.manifest)
    if (manifest.sourceId !== String(job.sourceId))
      throw new Error("Manifest belongs to another source")
    if (
      job.importedPages > 0 &&
      job.totalPages !== undefined &&
      job.totalPages !== manifest.pages.length
    )
      throw new Error("Draft page count changed during retry")
    await ctx.db.patch(job._id, {
      totalPages: manifest.pages.length,
      coverage: manifest.coverage,
      updatedAt: Date.now(),
    })
  },
})

/** Imports one page idempotently, preserving unchanged question and answer IDs. */
export const commitPage = mutation({
  args: {
    jobId: v.id("contentGenerationJobs"),
    leaseToken: v.string(),
    payloadHash: v.string(),
    page: v.any(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    if (job.totalPages === undefined)
      throw new Error("Draft manifest is missing")
    if (!/^[a-f0-9]{64}$/.test(args.payloadHash))
      throw new Error("Page hash is invalid")
    const references = (
      args.page as { sourceReferences?: Array<{ sourceId?: string }> }
    )?.sourceReferences
    if (!Array.isArray(references)) throw new Error("Page sources are missing")
    const sourceIds = new Set<string>()
    for (const reference of references) {
      const source = await ctx.db.get(reference.sourceId as Id<"sources">)
      if (!source || source.projectId !== job.projectId)
        throw new Error("Page cites a source outside this project")
      sourceIds.add(String(source._id))
    }
    const page = validateLessonDraft(
      args.page,
      job.depth,
      sourceIds,
      String(job.sourceId)
    )
    if (!page.conceptId && !page.questions.length)
      throw new Error("New concepts need at least one check question")
    const existingCommit = await ctx.db
      .query("contentPageCommits")
      .withIndex("by_job_page", (q) =>
        q.eq("jobId", job._id).eq("pageKey", page.key)
      )
      .first()
    if (existingCommit) {
      if (existingCommit.payloadHash !== args.payloadHash)
        throw new Error("Page draft changed after import")
      return { importedPages: job.importedPages, alreadyImported: true }
    }
    const now = Date.now()
    const existingTopic = await ctx.db
      .query("topics")
      .withIndex("by_project_title", (q) =>
        q.eq("projectId", job.projectId).eq("title", page.topicTitle)
      )
      .first()
    const topicId =
      existingTopic?._id ??
      (await ctx.db.insert("topics", {
        projectId: job.projectId,
        title: page.topicTitle,
        createdAt: now,
      }))
    let concept: Doc<"concepts"> | null = null
    if (page.conceptId) {
      concept = await ctx.db.get(page.conceptId as Id<"concepts">)
      if (!concept || concept.projectId !== job.projectId)
        throw new Error("Page concept is outside this project")
    } else {
      concept = await ctx.db
        .query("concepts")
        .withIndex("by_project_title", (q) =>
          q.eq("projectId", job.projectId).eq("title", page.conceptTitle)
        )
        .filter((q) => q.eq(q.field("topicId"), topicId))
        .first()
    }
    const conceptId =
      concept?._id ??
      (await ctx.db.insert("concepts", {
        projectId: job.projectId,
        topicId,
        title: page.conceptTitle,
        sourceIds: [...sourceIds] as Id<"sources">[],
        createdAt: now,
      }))
    if (concept)
      await ctx.db.patch(conceptId, {
        sourceIds: [
          ...new Set([...concept.sourceIds.map(String), ...sourceIds]),
        ] as Id<"sources">[],
      })
    const existingItems = await ctx.db
      .query("learningItems")
      .withIndex("by_concept_order", (q) => q.eq("conceptId", conceptId))
      .collect()
    const retiredIds = new Set(page.retireQuestionIds ?? [])
    for (const itemId of retiredIds) {
      const item = existingItems.find(
        (candidate) => String(candidate._id) === itemId
      )
      if (!item || item.type === "explain" || item.archivedAt)
        throw new Error("Retired question is not active in this concept")
      await ctx.db.patch(item._id, { archivedAt: now })
    }
    if (retiredIds.size) {
      const review = await ctx.db
        .query("conceptReviews")
        .withIndex("by_project_concept", (q) =>
          q.eq("projectId", job.projectId).eq("conceptId", conceptId)
        )
        .first()
      if (review)
        await ctx.db.patch(review._id, {
          answeredQuestionCount: 0,
          consecutiveCorrect: 0,
          dueAt: now,
          updatedAt: now,
        })
    }
    const activeExplanations = existingItems.filter(
      (item) => item.type === "explain" && !item.archivedAt
    )
    const current = activeExplanations[0]
    const referencesForDb = page.sourceReferences.map((reference) => ({
      sourceId: reference.sourceId as Id<"sources">,
      locator: reference.locator,
    }))
    const lastProjectItem = await ctx.db
      .query("learningItems")
      .withIndex("by_project_order", (q) => q.eq("projectId", job.projectId))
      .order("desc")
      .first()
    let nextOrder = (lastProjectItem?.order ?? -1) + 1
    if (current) {
      await ctx.db.insert("lessonPageRevisions", {
        projectId: job.projectId,
        itemId: current._id,
        jobId: job._id,
        title: current.title,
        body: current.body,
        ...(current.deepExplanation
          ? { deepExplanation: current.deepExplanation }
          : {}),
        sourceIds: current.sourceIds,
        ...(current.sourceReferences
          ? { sourceReferences: current.sourceReferences }
          : {}),
        replacedAt: now,
      })
      await ctx.db.patch(current._id, {
        title: page.title,
        body: page.bodyMarkdown,
        deepExplanation: undefined,
        updatedAt: now,
        sourceIds: [...sourceIds] as Id<"sources">[],
        sourceReferences: referencesForDb,
      })
    } else {
      await ctx.db.insert("learningItems", {
        projectId: job.projectId,
        conceptId,
        sourceIds: [...sourceIds] as Id<"sources">[],
        sourceReferences: referencesForDb,
        type: "explain",
        title: page.title,
        body: page.bodyMarkdown,
        order: nextOrder++,
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const duplicate of activeExplanations.slice(1))
      await ctx.db.patch(duplicate._id, { archivedAt: now })
    const knownQuestions = new Set(
      existingItems
        .filter(
          (item) =>
            item.type !== "explain" &&
            !item.archivedAt &&
            !retiredIds.has(String(item._id))
        )
        .map((item) => item.question?.trim().toLocaleLowerCase())
    )
    for (const question of page.questions) {
      const normalized = question.question.trim().toLocaleLowerCase()
      if (knownQuestions.has(normalized)) continue
      knownQuestions.add(normalized)
      await ctx.db.insert("learningItems", {
        projectId: job.projectId,
        conceptId,
        sourceIds: [...sourceIds] as Id<"sources">[],
        sourceReferences: referencesForDb,
        type: question.type,
        title: page.conceptTitle,
        body: question.feedback,
        question: question.question,
        ...(question.type === "true-false"
          ? { correctAnswer: question.correctAnswer }
          : question.type === "single-choice"
            ? {
                options: question.options,
                correctOptionId: question.correctOptionId,
              }
            : {
                options: question.options,
                correctOptionIds: question.correctOptionIds,
              }),
        order: nextOrder++,
        createdAt: now,
      })
    }
    await ctx.db.insert("contentPageCommits", {
      jobId: job._id,
      pageKey: page.key,
      payloadHash: args.payloadHash,
      createdAt: now,
    })
    await ctx.db.patch(job._id, {
      importedPages: job.importedPages + 1,
      updatedAt: now,
    })
    return { importedPages: job.importedPages + 1, alreadyImported: false }
  },
})

/** Finishes a fully imported draft and clears its source's preparation state. */
export const finish = mutation({
  args: { jobId: v.id("contentGenerationJobs"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    if (job.totalPages === undefined || job.importedPages !== job.totalPages)
      throw new Error("Some lesson pages were not imported")
    await ctx.db.patch(job._id, {
      status: "completed",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
      error: undefined,
    })
    await ctx.db.patch(job.sourceId, { status: "ready", error: undefined })
  },
})

/** Retains completed page commits and a safe reason when an agent job fails. */
export const fail = mutation({
  args: {
    jobId: v.id("contentGenerationJobs"),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    const error =
      args.error.trim().slice(0, 400) ||
      "Content generation failed. Retry to resume."
    await ctx.db.patch(job._id, {
      status: "failed",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      error,
      updatedAt: Date.now(),
    })
    await ctx.db.patch(job.sourceId, { status: "failed", error })
  },
})
