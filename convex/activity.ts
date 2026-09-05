/** Provides a bounded read-only activity feed for durable local preparation jobs. */

import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"

/** Maximum jobs read for each status so snapshots cannot exhaust a query. */
const MAX_JOBS_PER_STATUS = 6

/** Public preparation activity row with names and safe progress fields only. */
export type PreparationActivity = {
  jobId: string
  projectId: Doc<"projects">["_id"]
  projectTitle: string
  label: string
  status: "queued" | "leased" | "running" | "failed" | "completed" | "ready"
  stage: string
  elapsedMs: number
  section: number | null
  sectionCount: number | null
  generatedItemCount: number | null
  createdAt: number
  updatedAt: number
  error: string | null
  kind: "preparation" | "research" | "download" | "chat"
  elapsedSince: number | null
  href?: string
}

/** Lists active work and recent failures without returning snapshots or worker logs. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const [
      prepQueued,
      prepLeased,
      prepFailed,
      researchQueued,
      researchRunning,
      researchFailed,
      importQueued,
      importRunning,
      importFailed,
      messageQueued,
      messageRunning,
      messageFailed,
      messageCompleted,
    ] = await Promise.all([
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "leased"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_JOBS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "completed"))
        .order("desc")
        .take(4),
    ])
    const prep = [...prepLeased, ...prepQueued, ...prepFailed]
    const proposals = [...researchRunning, ...researchQueued, ...researchFailed]
    const imports = [...importRunning, ...importQueued, ...importFailed]
    const messages = [
      ...messageRunning,
      ...messageQueued,
      ...messageFailed,
      ...messageCompleted,
    ]
    const conversations = new Map(
      (
        await Promise.all(
          [...new Set(messages.map((message) => message.conversationId))].map(
            (id) => ctx.db.get(id)
          )
        )
      )
        .filter(
          (conversation): conversation is Doc<"conversations"> =>
            conversation !== null
        )
        .map((conversation) => [conversation._id, conversation])
    )
    const projectIds = new Set([
      ...prep.map((job) => job.projectId),
      ...proposals.map((job) => job.projectId),
      ...imports.map((job) => job.projectId),
      ...[...conversations.values()].map(
        (conversation) => conversation.projectId
      ),
    ])
    const projects = new Map(
      (await Promise.all([...projectIds].map((id) => ctx.db.get(id))))
        .filter((project): project is Doc<"projects"> => project !== null)
        .map((project) => [project._id, project])
    )
    const rows: PreparationActivity[] = []
    for (const job of prep) {
      const project = projects.get(job.projectId)
      if (!project) continue
      const sectionCount = job.totalChunks ?? null
      const section = sectionCount
        ? Math.min(job.nextChunkOrdinal + 1, sectionCount)
        : null
      rows.push({
        jobId: job._id,
        projectId: job.projectId,
        projectTitle: project.title,
        label: job.sourceFilename,
        kind: "preparation",
        status: job.status,
        stage:
          job.status === "queued"
            ? "Queued"
            : job.status === "failed"
              ? "Failed"
              : sectionCount
                ? `Preparing section ${section} of ${sectionCount}`
                : "Preparing source",
        elapsedMs:
          job.status === "failed"
            ? Math.max(0, job.updatedAt - job.createdAt)
            : 0,
        elapsedSince: job.status === "failed" ? null : job.createdAt,
        section,
        sectionCount,
        generatedItemCount: job.generatedItemCount ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.lastError?.trim().slice(0, 500) || null,
      })
    }
    for (const proposal of proposals) {
      const project = projects.get(proposal.projectId)
      if (!project) continue
      rows.push({
        jobId: proposal._id,
        projectId: proposal.projectId,
        projectTitle: project.title,
        label: proposal.request,
        kind: "research",
        status: proposal.status,
        stage:
          proposal.status === "failed"
            ? "Failed"
            : proposal.status === "queued"
              ? "Queued"
              : "Planning research",
        elapsedMs:
          proposal.status === "failed"
            ? Math.max(0, proposal.updatedAt - proposal.createdAt)
            : 0,
        elapsedSince: proposal.status === "failed" ? null : proposal.createdAt,
        section: null,
        sectionCount: null,
        generatedItemCount: null,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        error: proposal.lastError?.trim().slice(0, 500) || null,
      })
    }
    for (const importRow of imports) {
      const project = projects.get(importRow.projectId)
      if (!project) continue
      const proposal = await ctx.db.get(importRow.proposalId)
      const label =
        proposal?.sources[importRow.sourceIndex]?.title ||
        `Source ${importRow.sourceIndex + 1}`
      rows.push({
        jobId: importRow._id,
        projectId: importRow.projectId,
        projectTitle: project.title,
        label,
        kind: "download",
        status:
          importRow.status === "running"
            ? "running"
            : importRow.status === "queued"
              ? "queued"
              : "failed",
        stage:
          importRow.status === "failed"
            ? "Failed"
            : importRow.status === "queued"
              ? "Queued download"
              : "Downloading source",
        elapsedMs:
          importRow.status === "failed"
            ? Math.max(0, importRow.updatedAt - importRow.createdAt)
            : 0,
        elapsedSince:
          importRow.status === "failed" ? null : importRow.createdAt,
        section: null,
        sectionCount: null,
        generatedItemCount: null,
        createdAt: importRow.createdAt,
        updatedAt: importRow.updatedAt,
        error: importRow.lastError?.trim().slice(0, 500) || null,
      })
    }
    for (const message of messages) {
      const conversation = conversations.get(message.conversationId)
      if (!conversation) continue
      const project = projects.get(conversation.projectId)
      if (!project) continue
      rows.push({
        jobId: message._id,
        projectId: conversation.projectId,
        projectTitle: project.title,
        label: "Card reply",
        kind: "chat",
        href: `/chat?projectId=${encodeURIComponent(conversation.projectId)}&itemId=${encodeURIComponent(conversation.itemId)}`,
        status: message.status,
        stage:
          message.status === "failed"
            ? "Failed"
            : message.status === "queued"
              ? "Queued"
              : message.status === "completed"
                ? "Reply ready"
                : "Preparing reply",
        elapsedMs:
          message.status === "failed" || message.status === "completed"
            ? Math.max(0, message.updatedAt - message.createdAt)
            : 0,
        elapsedSince:
          message.status === "failed" || message.status === "completed"
            ? null
            : message.createdAt,
        section: null,
        sectionCount: null,
        generatedItemCount: null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        error: message.error?.trim().slice(0, 500) || null,
      })
    }
    return {
      hasActive:
        prepQueued.length +
          prepLeased.length +
          researchQueued.length +
          researchRunning.length +
          importQueued.length +
          importRunning.length +
          messageQueued.length +
          messageRunning.length >
        0,
      jobs: rows,
    }
  },
})
