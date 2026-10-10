/** Replays queued original-file ingestion jobs after local service restarts. */

import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"
import { api } from "../convex/_generated/api.js"
import { serverConvexClient } from "../lib/server/convex.ts"

/** Loads .env.local without replacing values supplied by the launcher. */
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

/** Returns a bounded diagnostic without exposing source content or credentials. */
function safeWorkerError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.trim() : "Unknown error"
  return message.replace(/\s+/g, " ").slice(0, 300) || "Unknown error"
}

/** Polls the durable ingestion queue and invokes the canonical retry route. */
async function main(): Promise<void> {
  loadLocalEnvironment()
  const serverUrl = process.env.BLITZ_SERVER_URL ?? "http://127.0.0.1:3007"
  const client = serverConvexClient(
    () => new Error("Set BLITZ_CONVEX_URL before starting the ingestion worker")
  )
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    console.log("Blitz ingestion worker is ready.")
    while (!controller.signal.aborted) {
      try {
        const jobs = await client.query(
          api.sources.listPendingOriginalIngestions,
          {}
        )
        for (const job of jobs) {
          const response = await fetch(`${serverUrl}/api/sources/retry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: job.projectId,
              sourceId: job.sourceId,
            }),
            signal: AbortSignal.timeout(30_000),
          })
          if (
            !response.ok &&
            response.status !== 202 &&
            response.status !== 422
          )
            console.error(
              `Ingestion retry for ${job.sourceId} returned HTTP ${response.status}.`
            )
        }
        await pause(jobs.length ? 250 : 1_000, undefined, {
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) break
        console.error(`Ingestion worker paused: ${safeWorkerError(error)}.`)
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

await main().catch((error) => {
  console.error(`Ingestion worker could not start: ${safeWorkerError(error)}.`)
  process.exitCode = 1
})
