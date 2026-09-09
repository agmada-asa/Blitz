/** Cancels one exact active workspace chat run without depending on its original stream. */

import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import { pauseChatRun } from "@/lib/server/chat-run-registry"

export const runtime = "nodejs"

/** Pauses the provider run identified by its persisted chat and assistant message IDs. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json(
      { error: "Open Blitz to pause a chat reply" },
      { status: 403 }
    )
  try {
    const body = (await request.json()) as unknown
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as { chatId?: unknown }).chatId !== "string" ||
      typeof (body as { messageId?: unknown }).messageId !== "string"
    )
      throw new Error("Chat and message IDs are required")
    const { chatId, messageId } = body as { chatId: string; messageId: string }
    if (!pauseChatRun(chatId, messageId))
      return Response.json(
        { error: "That reply is no longer running" },
        { status: 404 }
      )
    return Response.json({ paused: true })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Pause request is invalid",
      },
      { status: 400 }
    )
  }
}
