/** Persists bounded project-agent tasks and artifact metadata with project scope checks. */
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

/** Ensures a project-relative key cannot escape the workspace or enter reserved areas. */
function validateRelativeKey(relativeKey: string): void {
  const firstPart = relativeKey.split("/", 1)[0].toLowerCase()
  if (
    !relativeKey ||
    relativeKey.length > 1000 ||
    relativeKey.includes("\0") ||
    /^[A-Za-z]:/.test(relativeKey) ||
    relativeKey.startsWith("/") ||
    relativeKey.includes("\\") ||
    relativeKey
      .split("/")
      .some((part) => !part || part === ".." || part === ".") ||
    firstPart === "sources" ||
    firstPart === ".blitz"
  )
    throw new Error("Artifact key is outside the project workspace")
}

/** Validates optional artifact size and content hash metadata. */
function validateArtifactMetadata(
  sizeBytes: number | undefined,
  contentHash: string | undefined
): void {
  if (
    sizeBytes !== undefined &&
    (!Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > 25 * 1024 * 1024)
  )
    throw new Error("Artifact size is invalid")
  if (
    contentHash !== undefined &&
    (contentHash.length === 0 || contentHash.length > 256)
  )
    throw new Error("Artifact hash is invalid")
}

/** Validates an approval request before it is made visible to a user. */
function validateApproval(
  approval: { id: string; method: string; details: string; expiresAt: number },
  now: number
): void {
  if (
    !approval.id ||
    approval.id.length > 200 ||
    !approval.method ||
    approval.method.length > 200 ||
    approval.details.length > 20_000 ||
    !Number.isFinite(approval.expiresAt) ||
    approval.expiresAt <= now ||
    approval.expiresAt > now + 5 * 60 * 1000
  )
    throw new Error("Approval request is invalid")
}

const artifactInput = v.object({
  relativeKey: v.string(),
  kind: v.union(v.literal("file"), v.literal("directory")),
  sizeBytes: v.optional(v.number()),
  contentHash: v.optional(v.string()),
})

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
      .withIndex("by_project_source_ordinal", (q) =>
        q.eq("projectId", projectId)
      )
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
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    validateRelativeKey(args.relativeKey)
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_project_key", (q) =>
        q.eq("projectId", args.projectId).eq("relativeKey", args.relativeKey)
      )
      .first()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now })
      return existing._id
    }
    return ctx.db.insert("artifacts", {
      ...args,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/** Creates a task record only after checking the selected project exists. */
export const createTask = mutation({
  args: { projectId: v.id("projects"), title: v.string(), request: v.string() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
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

/** Synchronizes a complete artifact snapshot, marking missing prior rows as deleted. */
export const syncArtifacts = mutation({
  args: { projectId: v.id("projects"), artifacts: v.array(artifactInput) },
  handler: async (ctx, { projectId, artifacts }) => {
    if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
    if (artifacts.length > 500)
      throw new Error("Artifact snapshot is too large")
    const seen = new Set<string>()
    for (const artifact of artifacts) {
      validateRelativeKey(artifact.relativeKey)
      validateArtifactMetadata(artifact.sizeBytes, artifact.contentHash)
      if (seen.has(artifact.relativeKey))
        throw new Error("Artifact snapshot contains duplicate keys")
      seen.add(artifact.relativeKey)
    }
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_project_key", (q) => q.eq("projectId", projectId))
      .take(501)
    if (existing.length > 500)
      throw new Error("Artifact metadata exceeds the supported limit")
    const now = Date.now()
    const artifactIds = []
    for (const artifact of artifacts) {
      const row = existing.find(
        (candidate) => candidate.relativeKey === artifact.relativeKey
      )
      if (row) {
        await ctx.db.patch(row._id, {
          ...artifact,
          status: "active",
          updatedAt: now,
        })
        artifactIds.push(row._id)
      } else
        artifactIds.push(
          await ctx.db.insert("artifacts", {
            ...artifact,
            projectId,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
        )
    }
    for (const row of existing)
      if (!seen.has(row.relativeKey) && row.status !== "deleted")
        await ctx.db.patch(row._id, { status: "deleted", updatedAt: now })
    return artifactIds
  },
})
