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
import {
  MAX_CONCEPT_CONNECTIONS,
  validateConceptConnections,
} from "../lib/concept-map"
import { resolveQueuedContentSelection } from "./ai_provider_settings"

/** Worker steps that can be shown while a source is being processed. */
const contentStage = v.union(
  v.literal("preparing"),
  v.literal("generating"),
  v.literal("validating"),
  v.literal("importing")
)

/** Bounded tool activity accepted from the same provider normalizer as chat. */
const contentActivity = v.object({
  id: v.string(),
  type: v.literal("tool"),
  title: v.string(),
  status: v.union(
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed")
  ),
  detail: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
})

/** One page or saved concept named by a generated relationship. */
const relationshipEndpoint = v.union(
  v.object({ kind: v.literal("page"), key: v.string() }),
  v.object({ kind: v.literal("concept"), id: v.string() })
)

/** Relationship draft sent with the completed source job. */
const relationshipDraft = v.object({
  from: relationshipEndpoint,
  to: relationshipEndpoint,
  kind: v.string(),
  explanation: v.string(),
  evidence: v.array(
    v.object({
      sectionId: v.optional(v.string()),
      locator: v.string(),
    })
  ),
})

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
          stage: undefined,
          thought: undefined,
          activity: undefined,
          startedAt: undefined,
          durationMs: undefined,
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
              stage: job.stage ?? null,
            }
          )
        })
      )
    ).filter((job) => job !== null)
  },
})

/** Returns one source's bounded provider trace for its detail page. */
export const getProgress = query({
  args: { projectId: v.id("projects"), sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source || source.projectId !== args.projectId) return null
    const job = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_project_source", (q) =>
        q.eq("projectId", args.projectId).eq("sourceId", args.sourceId)
      )
      .first()
    return job
      ? {
          thought: job.thought ?? null,
          activity: job.activity ?? [],
          startedAt: job.startedAt ?? job._creationTime,
          durationMs: job.durationMs ?? null,
        }
      : null
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

/** Claims the oldest available source, with one live generation lease per project. */
export const claimNext = mutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, args) => {
    if (!args.leaseToken.trim() || args.leaseToken.length > 128)
      throw new Error("Lease token is invalid")
    const now = Date.now()
    const queued = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
      .take(200)
    const expired = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_status_lease", (q) =>
        q.eq("status", "leased").lte("leaseExpiresAt", now)
      )
      .take(200)
    const candidates = [...queued, ...expired].sort(
      (left, right) => left.createdAt - right.createdAt
    )
    let job: (typeof candidates)[number] | undefined
    const busyProjects = new Set<string>()
    for (const candidate of candidates) {
      if (busyProjects.has(String(candidate.projectId))) continue
      // A later file must see links committed by earlier files in this project.
      const activeLease = await ctx.db
        .query("contentGenerationJobs")
        .withIndex("by_project_status_lease", (q) =>
          q
            .eq("projectId", candidate.projectId)
            .eq("status", "leased")
            .gt("leaseExpiresAt", now)
        )
        .first()
      if (activeLease) busyProjects.add(String(candidate.projectId))
      else {
        job = candidate
        break
      }
    }
    if (!job) return null
    const source = await ctx.db.get(job.sourceId)
    const project = await ctx.db.get(job.projectId)
    if (!source || !project) throw new Error("Content job source is missing")
    await ctx.db.patch(job._id, {
      status: "leased",
      leaseToken: args.leaseToken,
      leaseExpiresAt: now + LEASE_MS,
      stage: "preparing",
      thought: undefined,
      activity: undefined,
      startedAt: now,
      durationMs: undefined,
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

/** Saves a worker step and bounded provider trace only while its lease is current. */
export const updateProgress = mutation({
  args: {
    jobId: v.id("contentGenerationJobs"),
    leaseToken: v.string(),
    stage: contentStage,
    thought: v.string(),
    activity: v.array(contentActivity),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    if (args.thought.length > 16_000 || args.activity.length > 64)
      throw new Error("Content progress exceeds its size limit")
    if (
      args.activity.some(
        (event) =>
          event.id.length > 200 ||
          event.title.length > 120 ||
          (event.detail?.length ?? 0) > 500
      )
    )
      throw new Error("Content activity exceeds its size limit")
    await ctx.db.patch(job._id, {
      stage: args.stage,
      thought: args.thought,
      activity: args.activity,
      updatedAt: Date.now(),
    })
  },
})

/** Reopens a partial import when its local drafts disappeared before retry. */
export const restartMissingDraft = mutation({
  args: { jobId: v.id("contentGenerationJobs"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    const commits = await ctx.db
      .query("contentPageCommits")
      .withIndex("by_job_page", (q) => q.eq("jobId", job._id))
      .collect()
    for (const commit of commits) await ctx.db.delete(commit._id)
    await ctx.db.patch(job._id, {
      importedPages: 0,
      totalPages: undefined,
      coverage: undefined,
      updatedAt: Date.now(),
    })
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
        ...(page.aliases?.length ? { aliases: page.aliases } : {}),
        sourceIds: [...sourceIds] as Id<"sources">[],
        createdAt: now,
      }))
    if (concept) {
      const aliases = [
        ...(concept.aliases ?? []),
        ...(page.conceptTitle.toLocaleLowerCase() ===
        concept.title.toLocaleLowerCase()
          ? []
          : [page.conceptTitle]),
        ...(page.aliases ?? []),
      ]
        .filter(
          (alias, index, all) =>
            alias.toLocaleLowerCase() !== concept.title.toLocaleLowerCase() &&
            all.findIndex(
              (candidate) =>
                candidate.toLocaleLowerCase() === alias.toLocaleLowerCase()
            ) === index
        )
        .slice(0, 24)
      await ctx.db.patch(conceptId, {
        aliases,
        sourceIds: [
          ...new Set([...concept.sourceIds.map(String), ...sourceIds]),
        ] as Id<"sources">[],
      })
    }
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
      conceptId,
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
  args: {
    jobId: v.id("contentGenerationJobs"),
    leaseToken: v.string(),
    connections: v.optional(v.array(relationshipDraft)),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job) throw new Error("Content job not found")
    requireLease(job, args.leaseToken)
    if (job.totalPages === undefined || job.importedPages !== job.totalPages)
      throw new Error("Some lesson pages were not imported")
    const commits = await ctx.db
      .query("contentPageCommits")
      .withIndex("by_job_page", (q) => q.eq("jobId", job._id))
      .take(251)
    if (commits.length !== job.totalPages)
      throw new Error("Lesson page checkpoints are incomplete")
    // Resolve existing endpoints against the project before replacing any saved links.
    const conceptIds = new Set<string>()
    for (const connection of args.connections ?? [])
      for (const endpoint of [connection.from, connection.to])
        if (endpoint.kind === "concept") conceptIds.add(endpoint.id)
    const validConceptIds = new Set<string>()
    for (const id of conceptIds) {
      const concept = await ctx.db.get(id as Id<"concepts">)
      if (concept?.projectId === job.projectId) validConceptIds.add(id)
    }
    const includedSectionIds = new Set(
      job.coverage
        ?.filter((entry) => entry.status === "included")
        .map((entry) => entry.sectionId) ?? []
    )
    const connections = validateConceptConnections(args.connections ?? [], {
      pageKeys: new Set(commits.map((commit) => commit.pageKey)),
      knownConceptIds: validConceptIds,
      includedSectionIds,
      extractedSectionIds: new Set(
        job.coverage
          ?.filter((entry) => entry.sectionId.startsWith("chunk_"))
          .map((entry) => entry.sectionId) ?? []
      ),
    })
    const pageConceptIds = new Map(
      commits.map((commit) => [commit.pageKey, commit.conceptId])
    )
    // One row per source keeps provenance separate when several files support a link.
    const savedLinks = await ctx.db
      .query("conceptRelationships")
      .withIndex("by_project_source", (q) =>
        q.eq("projectId", job.projectId).eq("sourceId", job.sourceId)
      )
      .take(MAX_CONCEPT_CONNECTIONS + 1)
    if (savedLinks.length > MAX_CONCEPT_CONNECTIONS)
      throw new Error("Source has too many saved concept relationships")
    for (const link of savedLinks) await ctx.db.delete(link._id)
    const now = Date.now()
    const seenLinks = new Set<string>()
    for (const connection of connections) {
      let fromConceptId =
        connection.from.kind === "page"
          ? pageConceptIds.get(connection.from.key)
          : (connection.from.id as Id<"concepts">)
      let toConceptId =
        connection.to.kind === "page"
          ? pageConceptIds.get(connection.to.key)
          : (connection.to.id as Id<"concepts">)
      if (!fromConceptId || !toConceptId)
        throw new Error("Concept relationship has an uncommitted page")
      if (fromConceptId === toConceptId)
        throw new Error("A concept cannot link to itself")
      if (
        (connection.kind === "contrasts_with" ||
          connection.kind === "related_to") &&
        String(fromConceptId) > String(toConceptId)
      )
        [fromConceptId, toConceptId] = [toConceptId, fromConceptId]
      const key = `${connection.kind}\0${fromConceptId}\0${toConceptId}`
      if (seenLinks.has(key))
        throw new Error("Source repeats a concept relationship")
      seenLinks.add(key)
      await ctx.db.insert("conceptRelationships", {
        projectId: job.projectId,
        sourceId: job.sourceId,
        fromConceptId,
        toConceptId,
        kind: connection.kind,
        explanation: connection.explanation,
        evidence: connection.evidence,
        createdAt: now,
      })
    }
    await ctx.db.patch(job._id, {
      status: "completed",
      durationMs: job.startedAt ? now - job.startedAt : undefined,
      activity: job.activity?.map((event) =>
        event.status === "running"
          ? { ...event, status: "completed" as const, completedAt: now }
          : event
      ),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
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
    const now = Date.now()
    await ctx.db.patch(job._id, {
      status: "failed",
      durationMs: job.startedAt ? now - job.startedAt : undefined,
      activity: job.activity?.map((event) =>
        event.status === "running"
          ? { ...event, status: "failed" as const, completedAt: now }
          : event
      ),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      error,
      updatedAt: now,
    })
    await ctx.db.patch(job.sourceId, { status: "failed", error })
  },
})
