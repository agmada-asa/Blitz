/** Starts the local, subscription-authenticated worker that drains saved source jobs. */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import type { Id } from "../convex/_generated/dataModel.js"
import {
  runPreparationStep,
  type PreparationQueue,
} from "../lib/server/preparation-worker.ts"
import { runCodexTextTurn } from "../lib/server/card-chat.ts"
import { loadSavedAiModelSettings } from "../lib/server/ai-model-settings.ts"
import {
  resolveAiModel,
  resolveAiReasoningEffort,
} from "../lib/ai-model-settings.ts"

/** Loads local configuration without overwriting variables supplied by the launcher. */
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

/** Connects the queue adapter and processes one chunk at a time until interrupted. */
async function main(): Promise<void> {
  loadLocalEnvironment()
  const endpoint =
    process.env.BLITZ_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL
  if (!endpoint)
    throw new Error("Set NEXT_PUBLIC_CONVEX_URL before starting the worker")
  const client = new ConvexHttpClient(endpoint)
  const controller = new AbortController()
  const workerId = `blitz-${randomUUID()}`
  const once = process.argv.includes("--once")
  /** Stops between checkpoints and interrupts the current model turn. */
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const queue: PreparationQueue = {
    claimNext: async (args) => {
      const claim = await client.mutation(api.preparation.claimNext, args)
      return claim ? { ...claim, nextChunk: claim.nextChunk.ordinal } : null
    },
    commitChunk: (args) =>
      client.mutation(api.preparation.commitChunk, {
        ...args,
        jobId: args.jobId as Id<"preparationJobs">,
      }),
    failJob: (args) =>
      client.mutation(api.preparation.failJob, {
        ...args,
        jobId: args.jobId as Id<"preparationJobs">,
      }),
  }
  try {
    console.log("Blitz preparation worker is ready.")
    while (!controller.signal.aborted) {
      try {
        const result = await runPreparationStep(
          queue,
          async (prompt, signal) => {
            // Keep imported material away from the repository and unrelated files.
            const workspaceDirectory = await mkdtemp(
              join(tmpdir(), "blitz-learning-")
            )
            try {
              const settings = await loadSavedAiModelSettings(client)
              const turn = await runCodexTextTurn({
                workspaceDirectory,
                prompt,
                signal,
                timeoutMs: 120_000,
                ephemeral: true,
                // Preparation must stay grounded in the uploaded source section.
                webSearchMode: "disabled",
                model: resolveAiModel(
                  settings,
                  "cardGenerationModel",
                  process.env.BLITZ_CODEX_MODEL
                ),
                effort: resolveAiReasoningEffort(
                  settings,
                  "cardGenerationEffort",
                  process.env.BLITZ_CODEX_EFFORT
                ),
              })
              return turn.text
            } finally {
              await rm(workspaceDirectory, { recursive: true, force: true })
            }
          },
          { workerId, signal: controller.signal }
        )
        if (result.status === "prepared") {
          console.log(
            `Prepared section ${result.ordinal + 1}/${result.totalChunks} for ${result.jobId}.`
          )
        } else if (once) {
          console.log("No queued sources.")
        }
        if (once) break
        if (result.status === "idle")
          await pause(3_000, undefined, { signal: controller.signal })
      } catch {
        if (controller.signal.aborted) break
        console.error(
          "A preparation step failed. Its saved progress remains available for retry."
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
    "Blitz worker could not start. Check the local server and configuration."
  )
  process.exitCode = 1
})
