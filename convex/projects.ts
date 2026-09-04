/** Provides project reads and project creation for the library interface. */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

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
