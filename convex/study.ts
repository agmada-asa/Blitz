/**
 * Serves the bounded question deck used by deliberate study and test sessions.
 *
 * The query reads existing learning items and review summaries without adding
 * a second session table. It returns only question content, so answer keys and
 * post-answer explanations remain behind the answer mutation.
 */

import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"

import { query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"

/** Maximum number of questions one session page may request. */
export const MAX_STUDY_PAGE_SIZE = 20

/** Question formats that deliberate sessions can present. */
const questionTypes: ReadonlySet<StudyQuestion["type"]> = new Set([
  "single-choice",
  "multiple-answer",
  "true-false",
] as const)

/** Read-only database context used by the deck query helpers. */
type StudyReadContext = Pick<QueryCtx, "db">

/** Public question payload with server-owned answer fields removed. */
export type StudyQuestion = {
  itemId: Id<"learningItems">
  projectId: Id<"projects">
  conceptId: Id<"concepts">
  topicId?: Id<"topics">
  type: "single-choice" | "multiple-answer" | "true-false"
  title: string
  prompt: string
  options?: Array<{ id: string; text: string }>
  order: number
}

/** Bounded page returned to browser and native session clients. */
export type StudyQuestionPage = {
  items: StudyQuestion[]
  isDone: boolean
  continueCursor: string
}

/** Confirms that the requested project exists before scanning its items. */
async function requireProject(
  ctx: StudyReadContext,
  projectId: Id<"projects">
): Promise<void> {
  if (!(await ctx.db.get(projectId))) throw new Error("Project not found")
}

/** Confirms that an optional topic belongs to the selected project. */
async function requireTopic(
  ctx: StudyReadContext,
  projectId: Id<"projects">,
  topicId: Id<"topics"> | undefined
): Promise<void> {
  if (!topicId) return
  const topic = await ctx.db.get(topicId)
  if (!topic || topic.projectId !== projectId)
    throw new Error("Topic does not belong to project")
}

/** Converts a stored question to a safe session payload without answer keys. */
function toStudyQuestion(
  item: Doc<"learningItems">,
  topicId: Id<"topics"> | undefined
): StudyQuestion | null {
  if (!questionTypes.has(item.type as StudyQuestion["type"])) return null
  if (!item.question?.trim()) return null

  return {
    itemId: item._id,
    projectId: item.projectId,
    conceptId: item.conceptId,
    ...(topicId ? { topicId } : {}),
    type: item.type as StudyQuestion["type"],
    title: item.title,
    prompt: item.question,
    ...(item.options ? { options: item.options } : {}),
    order: item.order,
  }
}

/**
 * Lists at most twenty question items for one project and optional topic.
 *
 * This query intentionally performs one bounded pagination operation. The
 * HTTP adapter follows the cursor across at most ten requests when it needs
 * to fill a sparse deck, because Convex does not allow multiple pagination
 * operations inside one query.
 */
export const listStudyQuestions = query({
  args: {
    projectId: v.id("projects"),
    topicId: v.optional(v.id("topics")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<StudyQuestionPage> => {
    await requireProject(ctx, args.projectId)
    await requireTopic(ctx, args.projectId, args.topicId)

    if (
      !Number.isSafeInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1
    )
      throw new Error("Study page size must be a positive integer")

    const items: StudyQuestion[] = []
    const page = await ctx.db
      .query("learningItems")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, MAX_STUDY_PAGE_SIZE),
      })
    for (const item of page.page) {
      if (item.type === "explain") continue
      const concept = await ctx.db.get(item.conceptId)
      if (
        !concept ||
        concept.projectId !== args.projectId ||
        (args.topicId !== undefined && concept.topicId !== args.topicId)
      )
        continue
      const safeQuestion = toStudyQuestion(item, concept.topicId)
      if (safeQuestion) items.push(safeQuestion)
    }

    return {
      items,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})
