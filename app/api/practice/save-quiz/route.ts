/**
 * Saves a quiz from a chat reply into a unit's question bank.
 *
 * The quiz is re-read from the saved assistant reply, so the browser cannot
 * change the question or its answer key; it only chooses which quiz and which
 * unit. Once saved, the question is drilled and shown in the feed like any
 * generated practice question.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { findQuizBlocks, quizPayload } from "@/lib/interactive-blocks"
import { serverConvexClient } from "@/lib/server/convex"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Error whose message is safe to show the learner. */
class SaveQuizError extends Error {}

/** Returns a bounded identifier string or throws a learner-safe error. */
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    throw new SaveQuizError(`${label} is invalid`)
  return value
}

/** Saves the requested quizzes and returns the unit they were saved to. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request))
      throw new SaveQuizError("Open Blitz to save questions")
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) throw new SaveQuizError("Save request is invalid")
    const chatId = boundedId(body.chatId, "Chat") as Id<"workspaceChats">
    const messageId = boundedId(body.messageId, "Message") as Id<"workspaceChatMessages">
    const unitId = boundedId(body.unitId, "Unit") as Id<"units">
    if (!Array.isArray(body.quizIds) || !body.quizIds.length || body.quizIds.length > 12)
      throw new SaveQuizError("Choose a question to save")
    const quizIds = body.quizIds.map((id) => boundedId(id, "Question"))

    const client = serverConvexClient()
    const chat = await client.query(api.workspaceChats.get, { chatId })
    const message = chat?.messages.find((item) => item.id === messageId)
    if (!message || message.role !== "assistant")
      throw new SaveQuizError("That question is no longer available")
    const quizzes = findQuizBlocks(message.content)
    let saved = 0
    for (const quizId of quizIds) {
      const quiz = quizzes.find((block) => block.id === quizId)
      if (!quiz) throw new SaveQuizError("That question is no longer available")
      const result = await client.mutation(api.practice.saveChatQuiz, {
        chatId,
        messageId,
        unitId,
        quiz: { id: quiz.id, ...quizPayload(quiz) },
      })
      if (!result.alreadySaved) saved += 1
    }
    return Response.json({ saved })
  } catch (error) {
    if (error instanceof SaveQuizError)
      return Response.json({ error: error.message }, { status: 400 })
    const message = error instanceof Error ? error.message : ""
    // Convex errors carry the mutation's learner-facing reason after "Uncaught Error: ".
    const reason = /Choose a unit in this chat's module|Save questions after the reply finishes/.exec(message)
    if (reason) return Response.json({ error: reason[0] }, { status: 400 })
    console.error("Chat question could not be saved", { message: message || "Unknown error" })
    return Response.json(
      { error: "The question could not be saved. Try again." },
      { status: 503 }
    )
  }
}
