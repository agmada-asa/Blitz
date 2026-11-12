/**
 * Reads preparation job progress for source lists and research imports.
 *
 * The batch preparation worker that leased these jobs has been removed.
 * Research imports still write completed jobs as import checkpoints, and
 * older rows remain readable so source status stays accurate.
 */

import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { v } from "convex/values"

/** Returns one job's progress in the stable shape the source views read. */
function progressFor(job: Doc<"preparationJobs">) {
  return {
    jobId: job._id,
    status: job.status,
    nextChunkOrdinal: job.nextChunkOrdinal,
    totalChunks: job.totalChunks ?? null,
    // Older jobs predate this counter; null keeps their progress honest.
    generatedItemCount: job.generatedItemCount ?? null,
    isComplete: job.status === "completed",
  }
}

/**
 * Most sources one job-status read may cover. The Sources page asks for every
 * source in the project at once, so this must exceed any real module. Each
 * source costs one indexed read, which keeps 500 well inside Convex's
 * per-query read limits.
 */
export const MAX_JOB_STATUS_SOURCES = 500

/** Lists preparation jobs for a project so source progress survives page reloads. */
export const listJobsForProject = query({
  args: {
    projectId: v.id("projects"),
    sourceIds: v.optional(v.array(v.id("sources"))),
  },
  handler: async (ctx, args) => {
    const sourceIds = args.sourceIds ?? []
    if (sourceIds.length > MAX_JOB_STATUS_SOURCES)
      throw new Error(
        `Job status may include at most ${MAX_JOB_STATUS_SOURCES} sources`
      )
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
    const now = Date.now()
    return jobs.map((job) => ({
      ...progressFor(job),
      sourceId: job.sourceId,
      error: job.lastError ?? null,
      leaseExpired: job.status === "leased" && (job.leaseExpiresAt ?? 0) <= now,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }))
  },
})
