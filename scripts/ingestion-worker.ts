/** Replays queued original-file ingestion jobs after local service restarts. */

import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"

/** Polls the durable ingestion queue and invokes the canonical retry route. */
async function main(): Promise<void> {
  const convexUrl = process.env.BLITZ_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL
  const serverUrl = process.env.BLITZ_SERVER_URL ?? "http://127.0.0.1:3001"
  if (!convexUrl) throw new Error("Set BLITZ_CONVEX_URL before starting the ingestion worker")
  const client = new ConvexHttpClient(convexUrl)
  while (true) {
    const jobs = await client.query(api.sources.listPendingOriginalIngestions, {})
    for (const job of jobs) {
      await fetch(`${serverUrl}/api/sources/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: job.projectId, sourceId: job.sourceId }) }).catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, jobs.length ? 250 : 1_000))
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Ingestion worker failed")
  process.exitCode = 1
})
