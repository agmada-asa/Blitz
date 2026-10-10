/**
 * Scores an answer to a quiz the tutor asked inside a Teach session and saves
 * it as study evidence.
 *
 * The quiz is re-read from the saved assistant reply, so the browser cannot
 * change the question or its correct answer. The first answer turns the quiz
 * into a learning item; every answer is recorded like any other question.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { findQuizBlocks } from "@/lib/interactive-blocks"
import { serverConvexClient } from "@/lib/server/convex"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Validated answer request. */
type TeachAnswerRequest = {
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
  quizId: string
  selectedOptionIds: string[]
  clientEventId: string
}

/** Error whose message is safe to show the learner. */
class TeachAnswerError extends Error {}

/** Returns a bounded identifier string or throws a learner-safe error. */
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,200}$/.test(value))
    throw new TeachAnswerError(`${label} is invalid`)
  return value
}

/** Parses the untrusted JSON body into a narrow request. */
function parseRequest(value: unknown): TeachAnswerRequest {
  if (!value || typeof value !== "object")
    throw new TeachAnswerError("Answer request is invalid")
  const body = value as Record<string, unknown>
  const selected = body.selectedOptionIds
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 8 ||
    new Set(selected).size !== selected.length
  )
    throw new TeachAnswerError("Choose an answer first")
  return {
    chatId: boundedId(body.chatId, "Session") as Id<"workspaceChats">,
    messageId: boundedId(body.messageId, "Message") as Id<"workspaceChatMessages">,
    quizId: boundedId(body.quizId, "Question"),
    selectedOptionIds: selected.map((id) => boundedId(id, "Answer")),
    clientEventId: boundedId(body.clientEventId, "Answer"),
  }
}

/** Records one Teach quiz answer and returns whether it was correct. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request))
      throw new TeachAnswerError("Open Blitz to answer questions")
    const input = parseRequest(await request.json().catch(() => null))
    const client = serverConvexClient()
    const chat = await client.query(api.workspaceChats.get, {
      chatId: input.chatId,
    })
    const message = chat?.messages.find((item) => item.id === input.messageId)
    if (!message || message.role !== "assistant")
      throw new TeachAnswerError("That question is no longer available")
    const quiz = findQuizBlocks(message.content).find(
      (block) => block.id === input.quizId
    )
    if (!quiz) throw new TeachAnswerError("That question is no longer available")
    const optionIds = new Set(quiz.options.map((option) => option.id))
    if (
      input.selectedOptionIds.some((id) => !optionIds.has(id)) ||
      (quiz.type !== "multiple-answer" && input.selectedOptionIds.length !== 1)
    )
      throw new TeachAnswerError("That answer does not match the question")
    const { projectId, itemId } = await client.mutation(api.teach.registerQuiz, {
      chatId: input.chatId,
      messageId: input.messageId,
      quiz: {
        id: quiz.id,
        concept: quiz.concept,
        type: quiz.type,
        question: quiz.question,
        options: quiz.options,
        correctOptionIds: quiz.correctOptionIds,
        explanation: quiz.explanation,
      },
    })
    const [first] = input.selectedOptionIds
    const result = await client.mutation(api.learning.recordAnswerEvent, {
      clientEventId: `teach:${input.clientEventId}`,
      projectId,
      itemId,
      occurredAt: Date.now(),
      answer:
        quiz.type === "true-false"
          ? first === "true"
          : quiz.type === "single-choice"
            ? first
            : input.selectedOptionIds,
    })
    if (result.status === "invalid")
      throw new TeachAnswerError("That answer does not match the question")
    return Response.json({ correct: result.isCorrect })
  } catch (error) {
    if (error instanceof TeachAnswerError)
      return Response.json({ error: error.message }, { status: 400 })
    console.error("Teach answer could not be saved", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return Response.json(
      { error: "Your answer could not be saved. Try again." },
      { status: 503 }
    )
  }
}
