/** Exposes bounded workspace chat history to the native chat screen. */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { LearningApiError } from "@/lib/server/learning-api"

/** Uses Node.js because the route reads the Convex workspace chat history. */
export const runtime = "nodejs"

/** Creates the configured Convex client or reports a safe service error. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(
    () => new LearningApiError("Chat is unavailable.", 503)
  )
}

/** Validates a chat identifier before passing it to Convex. */
function chatIdFor(value: string): Id<"workspaceChats"> {
  if (!/^[A-Za-z0-9]{1,128}$/.test(value))
    throw new LearningApiError("Chat ID is invalid.", 400)
  return value as Id<"workspaceChats">
}

/** Converts chat history errors into native-safe responses. */
function failure(error: unknown): Response {
  if (error instanceof LearningApiError)
    return Response.json({ error: error.message }, { status: error.status })
  return Response.json(
    { error: "Chat history is unavailable." },
    { status: 503 }
  )
}

/** Returns recent chat summaries or one bounded persisted transcript. */
export async function GET(request: Request): Promise<Response> {
  try {
    const client = convexClient()
    const chatValue = new URL(request.url).searchParams.get("chatId")
    if (!chatValue) {
      const chats = await client.query(api.workspaceChats.list, {})
      return Response.json(
        chats.slice(0, 60).map((chat) => ({
          id: String(chat.id),
          title: chat.title,
          projectId: chat.projectId ? String(chat.projectId) : undefined,
          projectTitle: chat.projectTitle ?? undefined,
          status: chat.status,
          updatedAt: chat.updatedAt,
        })),
        { headers: { "Cache-Control": "no-store" } }
      )
    }
    const chat = await client.query(api.workspaceChats.get, {
      chatId: chatIdFor(chatValue),
    })
    if (!chat)
      return Response.json({ error: "Chat not found." }, { status: 404 })
    const project = chat.projectId
      ? await client.query(api.projects.getProject, {
          projectId: chat.projectId,
        })
      : null
    let remaining = 250_000
    const messages = chat.messages.slice(-120).flatMap((message) => {
      if (remaining <= 0) return []
      const content = message.content.slice(0, Math.min(40_000, remaining))
      remaining -= content.length
      return [
        {
          id: String(message.id),
          role: message.role,
          content,
          status: message.status,
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        },
      ]
    })
    return Response.json(
      {
        id: String(chat.id),
        title: chat.title,
        projectId: chat.projectId ? String(chat.projectId) : undefined,
        projectTitle: project?.title,
        status: chat.status,
        updatedAt: chat.messages.at(-1)?.createdAt ?? Date.now(),
        messages,
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return failure(error)
  }
}
