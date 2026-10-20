/**
 * Turns quizzes asked inside Teach sessions into durable study evidence.
 *
 * A quiz the tutor writes becomes an ordinary learning item under a concept,
 * so its answers feed review scheduling, Practice, and the Review feed exactly
 * like any other question. The server route parses the quiz from the saved
 * assistant message; these functions only accept quizzes tied to a real
 * Teach reply.
 */

import { v } from "convex/values"

import { mutation, query } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { quizFields, quizItemFields } from "./quizFields"

/** Quiz shape accepted from the server route after it parsed the saved reply. */
const teachQuizValidator = v.object({ id: v.string(), ...quizFields })

/** Normalises a concept title for matching without changing how it is shown. */
function conceptKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 120)
}

/**
 * Returns the learning item for one Teach quiz, creating it and its concept on
 * first answer. Repeated calls for the same message and quiz reuse the item.
 * @returns The owning project and item, ready for `learning.recordAnswerEvent`.
 */
export const registerQuiz = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    quiz: teachQuizValidator,
  },
  handler: async (ctx, { chatId, messageId, quiz }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat || chat.purpose !== "teach" || !chat.projectId)
      throw new Error("Teach session not found")
    const message = await ctx.db.get(messageId)
    if (
      !message ||
      message.chatId !== chatId ||
      message.role !== "assistant" ||
      message.status !== "completed"
    )
      throw new Error("Answer quizzes after the reply finishes")
    const projectId = chat.projectId
    const teachKey = `${messageId}:${quiz.id}`
    const existing = await ctx.db
      .query("learningItems")
      .withIndex("by_project_teachKey", (q) =>
        q.eq("projectId", projectId).eq("teachKey", teachKey)
      )
      .first()
    if (existing) return { projectId, itemId: existing._id }

    const unitSources = chat.unitId
      ? await ctx.db
          .query("sources")
          .withIndex("by_unit", (q) => q.eq("unitId", chat.unitId))
          .collect()
      : []
    const sourceIds = unitSources.map((source) => source._id)
    const title = conceptKey(quiz.concept) || "Unit check"
    // Concepts are per unit: a generic title in two weeks is two concepts.
    let concept = (
      await ctx.db
        .query("concepts")
        .withIndex("by_project_title", (q) =>
          q.eq("projectId", projectId).eq("title", title)
        )
        .collect()
    ).find((candidate) => candidate.unitId === chat.unitId)
    const now = Date.now()
    if (!concept) {
      const conceptId = await ctx.db.insert("concepts", {
        projectId,
        ...(chat.unitId ? { unitId: chat.unitId } : {}),
        title,
        sourceIds,
        createdAt: now,
      })
      concept = (await ctx.db.get(conceptId))!
    }
    const itemId: Id<"learningItems"> = await ctx.db.insert("learningItems", {
      projectId,
      conceptId: concept._id,
      ...(chat.unitId ? { unitId: chat.unitId } : {}),
      teachKey,
      origin: "teach",
      sourceIds,
      title,
      ...quizItemFields(quiz),
      order: now,
      createdAt: now,
    })
    return { projectId, itemId }
  },
})

/**
 * Returns the latest recorded answer for every quiz in a Teach session, keyed
 * by message ID and then quiz ID, so the lesson shows answered state on reload.
 */
export const answeredQuizzes = query({
  args: { chatId: v.id("workspaceChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat || chat.purpose !== "teach" || !chat.projectId) return {}
    const projectId = chat.projectId
    const messages = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chatId))
      .collect()
    const answered: Record<
      string,
      Record<string, { selectedOptionIds: string[]; correct: boolean }>
    > = {}
    for (const message of messages) {
      if (message.role !== "assistant") continue
      // Keys are `<messageId>:<quizId>`, so one message's quizzes share a prefix.
      const items = await ctx.db
        .query("learningItems")
        .withIndex("by_project_teachKey", (q) =>
          q
            .eq("projectId", projectId)
            .gte("teachKey", `${message._id}:`)
            .lt("teachKey", `${message._id};`)
        )
        .collect()
      for (const item of items) {
        const event = await ctx.db
          .query("studyEvents")
          .withIndex("by_item_occurredAt", (q) => q.eq("itemId", item._id))
          .order("desc")
          .filter((q) => q.eq(q.field("eventType"), "answer"))
          .first()
        if (!event || event.answer === undefined || !event.outcome) continue
        const quizId = item.teachKey!.slice(message._id.length + 1)
        const selectedOptionIds =
          typeof event.answer === "boolean"
            ? [String(event.answer)]
            : Array.isArray(event.answer)
              ? event.answer
              : [event.answer]
        answered[message._id] = {
          ...answered[message._id],
          [quizId]: { selectedOptionIds, correct: event.outcome === "correct" },
        }
      }
    }
    return answered
  },
})

/**
 * Returns the learner's answers to a Teach session's pre-check: the quizzes in
 * the first tutor reply, each with its concept, question, and whether the
 * latest answer was right. Unanswered pre-check quizzes are left out. The chat
 * route sends these with `Plan my lesson` so the tutor can skip known sections.
 */
export const precheckResults = query({
  args: { chatId: v.id("workspaceChats") },
  handler: async (ctx, { chatId }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat || chat.purpose !== "teach" || !chat.projectId) return []
    const projectId = chat.projectId
    const first = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chatId))
      .filter((q) => q.eq(q.field("role"), "assistant"))
      .first()
    if (!first) return []
    const items = await ctx.db
      .query("learningItems")
      .withIndex("by_project_teachKey", (q) =>
        q
          .eq("projectId", projectId)
          .gte("teachKey", `${first._id}:`)
          .lt("teachKey", `${first._id};`)
      )
      .collect()
    const results: Array<{ concept: string; question: string; correct: boolean }> = []
    for (const item of items) {
      const event = await ctx.db
        .query("studyEvents")
        .withIndex("by_item_occurredAt", (q) => q.eq("itemId", item._id))
        .order("desc")
        .filter((q) => q.eq(q.field("eventType"), "answer"))
        .first()
      if (!event?.outcome) continue
      results.push({
        concept: item.title,
        question: item.question ?? "",
        correct: event.outcome === "correct",
      })
    }
    return results
  },
})
