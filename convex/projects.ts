import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const listProjects = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("projects").withIndex("by_createdAt").order("desc").collect(),
});

export const getProject = query({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.get(args.projectId),
});

export const createProject = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("Project title is required");
    if (title.length > 200) throw new Error("Project title is too long");
    return ctx.db.insert("projects", { title, createdAt: Date.now() });
  },
});
