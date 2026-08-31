import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_createdAt")
      .order("desc")
      .collect()

    return Promise.all(
      projects.map(async (project) => {
        const [sources, cards] = await Promise.all([
          ctx.db
            .query("sources")
            .withIndex("by_project", (query) =>
              query.eq("projectId", project._id)
            )
            .collect(),
          ctx.db
            .query("cards")
            .withIndex("by_project_order", (query) =>
              query.eq("projectId", project._id)
            )
            .collect(),
        ])

        return {
          ...project,
          sourceCount: sources.length,
          cardCount: cards.length,
        }
      })
    )
  },
})

export const getProject = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.get(args.projectId),
})

export const createProject = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const title = args.title.trim()
    if (!title) throw new Error("Project title is required")
    if (title.length > 200) throw new Error("Project title is too long")
    return ctx.db.insert("projects", { title, createdAt: Date.now() })
  },
})
