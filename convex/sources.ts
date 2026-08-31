import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

const sourceKind = v.union(
  v.literal("pdf"),
  v.literal("markdown"),
  v.literal("text"),
  v.literal("paste")
)
const sourceStatus = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed")
)

export const listSources = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) =>
    ctx.db
      .query("sources")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect(),
})

export const createSource = mutation({
  args: {
    projectId: v.id("projects"),
    filename: v.string(),
    kind: sourceKind,
    extractedText: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    const filename = args.filename.trim()
    const extractedText = args.extractedText.trim()
    if (!filename) throw new Error("Filename is required")
    if (!extractedText) throw new Error("Source text is required")
    if (extractedText.length > 2_000_000)
      throw new Error("Source text is too large")
    return ctx.db.insert("sources", {
      projectId: args.projectId,
      filename,
      kind: args.kind,
      extractedText,
      status: "processing",
      createdAt: Date.now(),
    })
  },
})

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
    const patch: {
      status: typeof args.status
      summary?: string
      error?: string
    } = { status: args.status }
    if (args.summary !== undefined) patch.summary = args.summary
    if (args.error !== undefined) patch.error = args.error
    await ctx.db.patch(args.sourceId, patch)
    return args.sourceId
  },
})

export const updateSourceGenerationResult = updateSource
