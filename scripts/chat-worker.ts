/** Starts the local subscription-authenticated worker for persisted card chats. */

import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { setTimeout as pause } from "node:timers/promises"
import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import type { Id } from "../convex/_generated/dataModel.js"
import {
  defaultChatWorkspaceDirectory,
  runChatWorkerStep,
  type ChatClaim,
  type ChatWorkContext,
  type ChatWorkerQueue,
} from "../lib/server/chat-worker.ts"
import { loadSavedAiModelSettings } from "../lib/server/ai-model-settings.ts"
import {
  resolveAiModel,
  resolveAiReasoningEffort,
} from "../lib/ai-model-settings.ts"

/** Loads .env.local without overwriting launcher-provided configuration. */
function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile(
      fileURLToPath(new URL("../.env.local", import.meta.url))
    )
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error
  }
}

/** Connects Convex and drains one or all queued card chat requests. */
async function main(): Promise<void> {
  loadLocalEnvironment()
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint)
    throw new Error(
      "Set NEXT_PUBLIC_CONVEX_URL before starting the chat worker"
    )
  const client = new ConvexHttpClient(endpoint)
  const controller = new AbortController()
  const workerId = `blitz-chat-${randomUUID()}`
  const once = process.argv.includes("--once")
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const queue: ChatWorkerQueue = {
    claimNext: async (args): Promise<ChatClaim | null> =>
      client.mutation(api.conversations.claimNext, args),
    getWorkContext: async (args): Promise<ChatWorkContext> =>
      client.query(api.conversations.getWorkContext, {
        messageId: args.messageId as Id<"conversationMessages">,
        leaseToken: args.leaseToken,
      }),
    progress: (args) =>
      client.mutation(api.conversations.progress, {
        ...args,
        messageId: args.messageId as Id<"conversationMessages">,
      }),
    complete: (args) =>
      client.mutation(api.conversations.complete, {
        messageId: args.messageId as Id<"conversationMessages">,
        leaseToken: args.leaseToken,
        codexThreadId: args.codexThreadId,
        codexTurnId: args.codexTurnId,
        reply: args.reply,
      }),
    fail: (args) =>
      client.mutation(api.conversations.fail, {
        messageId: args.messageId as Id<"conversationMessages">,
        leaseToken: args.leaseToken,
        error: args.error,
      }),
  }
  try {
    console.log("Blitz chat worker is ready.")
    while (!controller.signal.aborted) {
      try {
        const settings = await loadSavedAiModelSettings(client)
        const result = await runChatWorkerStep({
          queue,
          workerId,
          workspaceDirectory: defaultChatWorkspaceDirectory(),
          signal: controller.signal,
          model: resolveAiModel(
            settings,
            "replyModel",
            process.env.BLITZ_CODEX_MODEL
          ),
          effort: resolveAiReasoningEffort(
            settings,
            "replyEffort",
            process.env.BLITZ_CODEX_EFFORT
          ),
          onEvent: (event) => {
            if (event.type === "activity")
              console.log("Codex activity received.")
          },
        })
        if (result.status === "completed")
          console.log(`Completed card chat ${result.messageId}.`)
        if (result.status === "failed") {
          console.error(
            `Card chat ${result.messageId} failed; retry it deliberately from the client.`
          )
          if (once) process.exitCode = 1
        }
        if (once) break
        if (result.status === "idle")
          await pause(3_000, undefined, { signal: controller.signal })
      } catch {
        if (controller.signal.aborted) break
        console.error(
          "A card chat step failed. Saved history remains available for retry."
        )
        if (once) {
          process.exitCode = 1
          break
        }
        await pause(3_000, undefined, { signal: controller.signal }).catch(
          () => undefined
        )
      }
    }
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

await main().catch(() => {
  console.error(
    "Blitz chat worker could not start. Check the local server and configuration."
  )
  process.exitCode = 1
})
