/** Owns project metadata and atomic removal of project-owned study data. */

import { mutation, query } from "./_generated/server"
import { ConvexError, v } from "convex/values"
import type { Id, TableNames } from "./_generated/dataModel"

/** Lists project metadata newest first without scanning related collections. */
export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_createdAt")
      .order("desc")
      .collect()

    return projects
  },
})

/** Returns a project by ID, or null when it no longer exists. */
export const getProject = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.get(args.projectId),
})

/** Creates a project after trimming and bounding its user-visible title. */
export const createProject = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const title = args.title.trim()
    if (!title) throw new Error("Project title is required")
    if (title.length > 200) throw new Error("Project title is too long")
    return ctx.db.insert("projects", { title, createdAt: Date.now() })
  },
})

/** Renames an existing project without changing its sources or study history. */
export const renameProject = mutation({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: async (ctx, args) => {
    const title = args.title.trim()
    if (!title || title.length > 200)
      throw new ConvexError("Use a project name between 1 and 200 characters.")
    if (!(await ctx.db.get(args.projectId)))
      throw new ConvexError("This project no longer exists.")
    await ctx.db.patch(args.projectId, { title })
  },
})

/** Archives or restores a project. Archiving only sets `archivedAt`, so sources, study history and review schedules stay intact. */
export const setProjectArchived = mutation({
  args: { projectId: v.id("projects"), archived: v.boolean() },
  handler: async (ctx, { projectId, archived }) => {
    if (!(await ctx.db.get(projectId)))
      throw new ConvexError("This project no longer exists.")
    // Patching undefined removes the field, which restores the project.
    await ctx.db.patch(projectId, {
      archivedAt: archived ? Date.now() : undefined,
    })
  },
})

/** Deletes a project and its dependent records atomically. Failed or oversized deletions leave all data intact. */
export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!(await ctx.db.get(projectId))) return
    // Bound each indexed read and the total writes below Convex transaction limits.
    const rows: { _id: Id<TableNames> }[] = []
    /** Collects a bounded dependent group; throwing rolls back this entire mutation. */
    const add = (group: typeof rows) => {
      if (group.length > 2000 || rows.length + group.length > 8000) {
        throw new ConvexError(
          "This project is too large to delete at once. Nothing was deleted."
        )
      }
      rows.push(...group)
    }
    add(
      await ctx.db
        .query("sources")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("cards")
        .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("attempts")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("topics")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("concepts")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("conceptRelationships")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("learningItems")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("lessonPageRevisions")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("writingActivities")
        .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("studyEvents")
        .withIndex("by_project_clientEventId", (q) =>
          q.eq("projectId", projectId)
        )
        .take(2001)
    )
    add(
      await ctx.db
        .query("conceptReviews")
        .withIndex("by_project_concept", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    // Local bytes remain on disk for recovery; metadata must not outlive its
    // project or appear in retrieval and worker queues after deletion.
    add(
      await ctx.db
        .query("chatDocuments")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("sourceChunks")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("sourceOutlines")
        .withIndex("by_project_source", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("ingestionJobs")
        .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("artifacts")
        .withIndex("by_project_updatedAt", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    add(
      await ctx.db
        .query("agentTasks")
        .withIndex("by_project_updatedAt", (q) => q.eq("projectId", projectId))
        .take(2001)
    )
    const workspaceChats = await ctx.db
      .query("workspaceChats")
      .withIndex("by_project_updatedAt", (q) => q.eq("projectId", projectId))
      .take(2001)
    add(workspaceChats)
    for (const chat of workspaceChats) {
      add(
        await ctx.db
          .query("workspaceChatMessages")
          .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chat._id))
          .take(2001)
      )
      add(
        await ctx.db
          .query("workspaceChatAttachments")
          .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chat._id))
          .take(2001)
      )
    }
    const jobs = await ctx.db
      .query("preparationJobs")
      .withIndex("by_project_source", (q) => q.eq("projectId", projectId))
      .take(2001)
    add(jobs)
    for (const job of jobs)
      add(
        await ctx.db
          .query("preparationChunks")
          .withIndex("by_job_ordinal", (q) => q.eq("jobId", job._id))
          .take(2001)
      )
    const contentJobs = await ctx.db
      .query("contentGenerationJobs")
      .withIndex("by_project_source", (q) => q.eq("projectId", projectId))
      .take(2001)
    add(contentJobs)
    for (const job of contentJobs)
      add(
        await ctx.db
          .query("contentPageCommits")
          .withIndex("by_job_page", (q) => q.eq("jobId", job._id))
          .take(2001)
      )
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_project_item", (q) => q.eq("projectId", projectId))
      .take(2001)
    add(conversations)
    for (const conversation of conversations)
      add(
        await ctx.db
          .query("conversationMessages")
          .withIndex("by_conversation_createdAt", (q) =>
            q.eq("conversationId", conversation._id)
          )
          .take(2001)
      )
    const proposals = await ctx.db
      .query("researchProposals")
      .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
      .take(2001)
    add(proposals)
    for (const proposal of proposals)
      add(
        await ctx.db
          .query("researchProposalImports")
          .withIndex("by_proposal_sourceIndex", (q) =>
            q.eq("proposalId", proposal._id)
          )
          .take(2001)
      )
    // Removing job and lease records in this transaction prevents late worker commits.
    for (const row of rows) await ctx.db.delete(row._id)
    await ctx.db.delete(projectId)
  },
})
