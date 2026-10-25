/**
 * Compact now: summarises a Teach session's model context on the learner's
 * request, from the context sheet in the Teach header.
 *
 * The session is held while the runtime compacts, so no turn starts on the
 * thread meanwhile. The next turn restates the unit material, outline, and
 * plan, and the session shows where it was compacted. Blitz also compacts by
 * itself once the context passes its threshold; this is the same operation,
 * sooner.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { AiProviderId } from "@/lib/ai-model-settings"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import { serverConvexClient } from "@/lib/server/convex"
import { prepareProjectAgentWorkspace } from "@/lib/server/project-agent"
import { compactProviderThread } from "@/lib/server/providers/run-text-turn"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import {
  chatReplySelection,
  savedChatReplySelection,
  teachTurnSettings,
} from "@/lib/server/teach-turn-settings"

/** Uses Node.js because compaction resumes the local provider process. */
export const runtime = "nodejs"
/** Compaction can take a few minutes on a long session. */
export const maxDuration = 300

/** Longest a compaction may run before it is abandoned. */
const COMPACTION_TIMEOUT_MS = 270_000

/**
 * Compacts one Teach session now.
 *
 * @returns `{ compacted }`, or an error the Teach screen shows as is.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to compact a session" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as { chatId?: unknown } | null
  const chatId = body?.chatId
  if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(chatId))
    return Response.json({ error: "Teach session is required" }, { status: 400 })
  const client = serverConvexClient(() => new Error("Blitz data is unavailable"))
  let session
  try {
    session = await client.mutation(api.workspaceChats.beginCompaction, {
      chatId: chatId as Id<"workspaceChats">,
    })
  } catch (error) {
    // Convex errors carry the mutation's learner-facing reason after "Uncaught Error: ".
    const reason =
      /Wait for the reply to finish, then compact\.|Blitz is already compacting this session\.|This session can't be compacted\./.exec(
        error instanceof Error ? error.message : ""
      )
    return Response.json(
      { error: reason?.[0] ?? "This session can't be compacted." },
      { status: 409 }
    )
  }
  let result: Awaited<ReturnType<typeof compactProviderThread>> = { compacted: false }
  try {
    const configured = chatReplySelection(await loadSavedAiModelSettings(client))
    const providerId = session.providerId as AiProviderId
    const selection = savedChatReplySelection(configured, session)
    const workspaceDirectory = (
      await prepareProjectAgentWorkspace(session.projectId)
    ).projectDirectory
    result = await compactProviderThread({
      providerId,
      workspaceDirectory,
      model: selection.model,
      effort: selection.effort,
      threadId: session.providerSessionId,
      timeoutMs: COMPACTION_TIMEOUT_MS,
      ...teachTurnSettings(providerId, workspaceDirectory),
    })
  } finally {
    await client
      .mutation(api.workspaceChats.endCompaction, {
        chatId: chatId as Id<"workspaceChats">,
        compacted: result.compacted,
        ...(result.contextUsage
          ? { usage: { ...result.contextUsage, updatedAt: Date.now() } }
          : {}),
      })
      .catch((error: unknown) =>
        console.error("Teach could not finish a compaction", {
          message: error instanceof Error ? error.message : "Unknown error",
        })
      )
  }
  return result.compacted
    ? Response.json({ compacted: true })
    : Response.json(
        { error: "The session couldn't be compacted. Try again, or keep going: Blitz compacts it when it gets full." },
        { status: 502 }
      )
}
