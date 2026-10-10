/** Receives an explicit, single-use response for an agent request shown in the composer. */
import { serverConvexClient } from "@/lib/server/convex"
import { z } from "zod"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Agent request handling uses the same local Node host as chat execution. */
export const runtime = "nodejs"

/** Checks the browser origin and delegates scope, expiry, and active-message checks to Convex. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request))
      throw new Error("Open Blitz to review this request.")
    const body = z
      .object({
        chatId: z.string().min(1),
        messageId: z.string().min(1),
        approvalId: z.string().min(1),
        decision: z.enum(["approved", "denied"]),
        response: z.string().max(20_000).optional(),
      })
      .parse(await request.json())
    await serverConvexClient(
      () => new Error("Chats are unavailable.")
    ).mutation(api.chatAgents.decideApproval, {
      ...body,
      chatId: body.chatId as Id<"workspaceChats">,
      messageId: body.messageId as Id<"workspaceChatMessages">,
    })
    return Response.json({ saved: true })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Agent response could not be saved.",
      },
      { status: 400 }
    )
  }
}
