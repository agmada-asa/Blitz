/**
 * Starts the reply provider's runtime as soon as a new Teach session opens,
 * so the first turn finds it running instead of starting one.
 *
 * The Teach screen calls this once per session. Only a session with no
 * messages and no runtime session yet is prewarmed, with exactly the settings
 * its first turn will use; the engine waits in the pool for that turn and
 * closes itself if nothing claims it. Failures are silent: the turn simply
 * starts its own runtime, as it would without prewarm.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { providerThreadFeatures } from "@/lib/provider-thread-features"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import { serverConvexClient } from "@/lib/server/convex"
import { prepareProjectAgentWorkspace } from "@/lib/server/project-agent"
import { prewarmProviderTextTurn } from "@/lib/server/providers/run-text-turn"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import {
  chatReplySelection,
  teachTurnSettings,
} from "@/lib/server/teach-turn-settings"

/** Uses Node.js because prewarming starts a local provider process. */
export const runtime = "nodejs"

/**
 * Prewarms the runtime for a new Teach session's first turn.
 *
 * @returns `{ prewarmed }`; a session that does not need it, or a provider
 *   without prewarm, reports false.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to start a lesson" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as { chatId?: unknown } | null
  const chatId = body?.chatId
  if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(chatId))
    return Response.json({ error: "Teach session is required" }, { status: 400 })
  try {
    const client = serverConvexClient(() => new Error("Blitz data is unavailable"))
    const chat = await client.query(api.workspaceChats.get, {
      chatId: chatId as Id<"workspaceChats">,
    })
    // Only a new thread benefits: a resumed one cannot be opened ahead. The
    // first turn may already have saved its request and placeholder reply.
    if (
      !chat ||
      chat.purpose !== "teach" ||
      !chat.projectId ||
      chat.providerSessionId ||
      chat.messages.length > 2 ||
      chat.messages.some(
        (message) => message.role === "assistant" && message.status !== "running"
      )
    )
      return Response.json({ prewarmed: false })
    const selection = chatReplySelection(await loadSavedAiModelSettings(client))
    if (!providerThreadFeatures(selection.providerId).prewarm)
      return Response.json({ prewarmed: false })
    const workspaceDirectory = (
      await prepareProjectAgentWorkspace(chat.projectId)
    ).projectDirectory
    const prewarmed = await prewarmProviderTextTurn({
      providerId: selection.providerId,
      workspaceDirectory,
      model: selection.model,
      effort: selection.effort,
      ...teachTurnSettings(selection.providerId, workspaceDirectory),
    })
    return Response.json({ prewarmed })
  } catch (error) {
    console.warn("Teach could not prewarm the provider", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return Response.json({ prewarmed: false })
  }
}
