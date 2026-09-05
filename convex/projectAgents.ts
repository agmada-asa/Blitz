/** Persists bounded project-agent tasks and artifact metadata with project scope checks. */
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

/** Lists recent agent tasks without returning prompts or source content. */
export const listTasks = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
    return ctx.db
      .query("agentTasks")
      .withIndex("by_project_updatedAt", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(50)
  },
})

/** Lists artifact metadata for one project, excluding file contents. */
export const listArtifacts = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
    return ctx.db
      .query("artifacts")
      .withIndex("by_project_updatedAt", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(500)
  },
})

/** Lists ingestion state for the project's uploaded sources for the file browser. */
export const listIngestion = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
    return ctx.db
      .query("ingestionJobs")
      .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(500)
  },
})

/** Lists bounded source citation labels without exposing chunk text. */
export const listCitations = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
    const chunks = await ctx.db
      .query("sourceChunks")
      .withIndex("by_project_source_ordinal", (q) => q.eq("projectId", projectId))
      .take(500)
    return chunks.flatMap((chunk) =>
      chunk.references.length
        ? chunk.references.map((reference) => ({
            sourceId: chunk.sourceId,
            label: reference.label,
            detail: reference.value,
          }))
        : [{ sourceId: chunk.sourceId, label: `Section ${chunk.ordinal + 1}` }]
    )
  },
})

/** Records one filesystem snapshot; every mutation validates the parent project. */
export const upsertArtifact = mutation({
  args: {
    projectId: v.id("projects"),
    relativeKey: v.string(),
    kind: v.union(v.literal("file"), v.literal("directory")),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("deleted")),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found")
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_project_key", (q) =>
        q.eq("projectId", args.projectId).eq("relativeKey", args.relativeKey),
      )
      .first()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now })
      return existing._id
    }
    return ctx.db.insert("artifacts", { ...args, createdAt: now, updatedAt: now })
  },
})

/** Creates a task record only after checking the selected project exists. */
export const createTask = mutation({
  args: { projectId: v.id("projects"), title: v.string(), request: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found")
    const title = args.title.trim()
    const request = args.request.trim()
    if (!title || !request || title.length > 200 || request.length > 20_000)
      throw new Error("Agent task is invalid")
    const now = Date.now()
    return ctx.db.insert("agentTasks", {
      projectId: args.projectId,
      title,
      request,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
  },
})

/** Completes a task with only artifact IDs belonging to the same project. */
export const completeTask = mutation({
  args: {
    taskId: v.id("agentTasks"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    artifactIds: v.optional(v.array(v.id("artifacts"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId)
    if (!task) throw new Error("Agent task not found")
    const artifactIds = args.artifactIds ?? []
    for (const artifactId of artifactIds) {
      const artifact = await ctx.db.get(artifactId)
      if (!artifact || artifact.projectId !== task.projectId)
        throw new Error("Artifact does not belong to this project")
    }
    await ctx.db.patch(args.taskId, {
      status: args.status,
      artifactIds,
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      updatedAt: Date.now(),
    })
  },
})

/** Marks a queued task as running after its native process has been launched. */
export const startTask = mutation({
  args: { taskId: v.id("agentTasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId)
    if (!task) throw new Error("Agent task not found")
    await ctx.db.patch(taskId, { status: "running", updatedAt: Date.now() })
  },
})
