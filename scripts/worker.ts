/**
 * Starts Blitz's single background worker process.
 *
 * One Node process runs two independent polling loops that used to be
 * separate workers:
 *
 * - `ingestion` replays queued original-file ingestion jobs after restarts by
 *   calling the canonical `/api/sources/retry` route.
 * - `research` imports approved Deep Research sources and prepares
 *   approval-first research proposals.
 *
 * Each loop runs through `runWorkerLoop`, so a failing step is logged and
 * retried with backoff without stopping the other loop. The supervisor in
 * `electron/service-manager.mjs` starts this process for `npm run dev:lan`
 * and the desktop app, and restarts it if it exits. The Kokoro speech worker
 * is a separate Python process and is not part of this one.
 *
 *   npm run worker [-- --only ingestion|research] [--once]
 */

import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import type { Id } from "../convex/_generated/dataModel.js"
import { serverConvexClient } from "../lib/server/convex.ts"
import { runWorkerLoop } from "../lib/server/worker-loop.ts"
import {
  defaultChatWorkspaceDirectory,
  runResearchProposalStep,
  type ResearchProposalClaim,
  type ResearchProposalQueue,
} from "../lib/server/research-worker.ts"
import {
  runResearchImportStep,
  type ResearchImportClaim,
  type ResearchImportQueue,
  type ResearchImportFailureCategory,
} from "../lib/server/research-import-worker.ts"
import { loadSavedAiModelSettings } from "../lib/server/ai-model-settings.ts"
import {
  isAiProviderId,
  resolveAiTaskSelection,
} from "../lib/ai-model-settings.ts"

/** Names of the loops this process can run. */
const LOOP_NAMES = ["ingestion", "research"] as const

/** One loop hosted by the worker process. */
type LoopName = (typeof LOOP_NAMES)[number]

/** Parsed command-line options. */
type WorkerOptions = { loops: LoopName[]; once: boolean }

/** Usage text printed for `--help` and invalid arguments. */
const USAGE = `Usage: npm run worker [-- --only ingestion|research] [--once]

Runs Blitz's background loops in one process:
  ingestion  replays queued source ingestion after restarts
  research   imports approved research sources and prepares proposals

  --only <loop>  run one loop instead of both
  --once         run one step of each loop, then exit (exit code 1 on failure)
  --help         show this message`

/**
 * Reads command-line flags. Returns `null` after printing usage for `--help`
 * or invalid input, with `process.exitCode` set accordingly.
 */
function parseOptions(argv: string[]): WorkerOptions | null {
  let loops: LoopName[] = [...LOOP_NAMES]
  let once = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      console.log(USAGE)
      return null
    }
    if (argument === "--once") once = true
    else if (argument === "--only" || argument.startsWith("--only=")) {
      const value =
        argument === "--only" ? argv[++index] : argument.slice("--only=".length)
      const loop = LOOP_NAMES.find((name) => name === value)
      if (!loop) {
        console.error(`Unknown loop "${value ?? ""}".\n\n${USAGE}`)
        process.exitCode = 1
        return null
      }
      loops = [loop]
    } else {
      console.error(`Unknown option "${argument}".\n\n${USAGE}`)
      process.exitCode = 1
      return null
    }
  }
  return { loops, once }
}

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

/** Describes when a failed loop will try again, for log lines. */
function retryNote(retryInMs: number | null): string {
  return retryInMs === null
    ? ""
    : ` Retrying in ${Math.round(retryInMs / 1_000)}s.`
}

/**
 * Builds one ingestion step: asks the Next server to resume every pending
 * original-file ingestion, then waits briefly when work was found and longer
 * when the queue is empty.
 */
function ingestionStep(
  client: ConvexHttpClient,
  serverUrl: string
): (signal: AbortSignal) => Promise<number> {
  return async () => {
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
      // 202 means the retry was accepted; 422 is a file that cannot be
      // ingested, which stays failed until the user retries it.
      if (!response.ok && response.status !== 202 && response.status !== 422)
        console.error(
          `Ingestion retry for ${job.sourceId} returned HTTP ${response.status}.`
        )
    }
    return jobs.length ? 250 : 1_000
  }
}

/** Adapts the Convex research mutations to the queue the research steps expect. */
function researchQueue(
  client: ConvexHttpClient
): ResearchProposalQueue & ResearchImportQueue {
  return {
    claimNext: async (args): Promise<ResearchProposalClaim | null> => {
      const claim = await client.mutation(api.research.claimNext, args)
      if (!claim) return null
      const { providerId, ...rest } = claim
      return {
        ...rest,
        ...(isAiProviderId(providerId) ? { providerId } : {}),
      }
    },
    complete: (args) =>
      client.mutation(api.research.complete, {
        proposalId: args.proposalId as Id<"researchProposals">,
        leaseToken: args.leaseToken,
        proposal: {
          ...args.proposal,
          topics: Array.from(args.proposal.topics),
          sources: Array.from(args.proposal.sources),
          generatedNotes: Array.from(args.proposal.generatedNotes),
        },
      }),
    fail: (args) =>
      client.mutation(api.research.fail, {
        proposalId: args.proposalId as Id<"researchProposals">,
        leaseToken: args.leaseToken,
        error: args.error,
      }),
    recordActivity: (args) =>
      client.mutation(api.research.recordActivity, {
        proposalId: args.proposalId as Id<"researchProposals">,
        leaseToken: args.leaseToken,
        event: args.event,
      }),
    claimNextImport: async (args): Promise<ResearchImportClaim | null> => {
      const claim = await client.mutation(api.research.claimNextImport, args)
      return claim
        ? {
            ...claim,
            source: { ...claim.source, verification: "suggested-unverified" },
          }
        : null
    },
    completeImport: (args) =>
      client.mutation(api.research.completeImport, {
        importId: args.importId as Id<"researchProposalImports">,
        leaseToken: args.leaseToken,
        filename: args.filename,
        kind: args.kind,
        extractedText: args.extractedText,
        originalUrl: args.originalUrl,
        ...(args.partNumber === undefined
          ? {}
          : { partNumber: args.partNumber }),
        ...(args.totalParts === undefined
          ? {}
          : { totalParts: args.totalParts }),
      }),
    failImport: (args) =>
      client.mutation(api.research.failImport, {
        importId: args.importId as Id<"researchProposalImports">,
        leaseToken: args.leaseToken,
        failureCategory: args.failureCategory as ResearchImportFailureCategory,
      }),
  }
}

/**
 * Builds one research step. Approved source imports go first because the
 * user is waiting on them; a proposal is prepared only when no import is
 * queued. The loop pauses for three seconds when both queues are empty.
 */
function researchStep(
  client: ConvexHttpClient
): (signal: AbortSignal) => Promise<number> {
  const queue = researchQueue(client)
  const workerId = `blitz-research-${randomUUID()}`
  return async (signal) => {
    const importResult = await runResearchImportStep({
      queue,
      workerId,
      signal,
    })
    if (importResult.status === "imported")
      console.log(`Imported approved research source ${importResult.importId}.`)
    if (importResult.status === "failed")
      console.error(
        `Approved research source ${importResult.importId} failed (${importResult.failureCategory}); retry it deliberately.`
      )
    if (importResult.status !== "idle") return 0

    // Read settings on every proposal so a provider change in Settings
    // applies without restarting the worker.
    const settings = await loadSavedAiModelSettings(client)
    const selection = resolveAiTaskSelection(settings, "research", {
      providerEnvironmentFallback: process.env.BLITZ_RESEARCH_PROVIDER,
      modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
      effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
    })
    const result = await runResearchProposalStep({
      queue,
      workerId,
      workspaceDirectory: defaultChatWorkspaceDirectory(),
      signal,
      providerId: selection.providerId,
      model: selection.model,
      effort: selection.effort,
    })
    if (result.status === "ready")
      console.log(`Prepared research proposal ${result.proposalId}.`)
    if (result.status === "failed")
      console.error(
        `Research proposal ${result.proposalId} failed (${result.failureKind}${result.failureDetail ? `: ${result.failureDetail}` : ""}); retry it deliberately.`
      )
    return result.status === "idle" ? 3_000 : 0
  }
}

/** Connects to Convex and runs the selected loops until the process is stopped. */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (!options) return
  loadLocalEnvironment()
  const client = serverConvexClient(
    () => new Error("Set BLITZ_CONVEX_URL before starting the worker")
  )
  const serverUrl = process.env.BLITZ_SERVER_URL ?? "http://127.0.0.1:3007"
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  // A stray rejection from one loop's dependencies would otherwise end the
  // whole process and stop the other loop too.
  const reportStrayRejection = (reason: unknown): void =>
    console.error(`Worker ignored an unhandled error: ${safeWorkerError(reason)}.`)
  process.on("unhandledRejection", reportStrayRejection)

  const loops: Record<LoopName, () => Promise<boolean>> = {
    ingestion: () =>
      runWorkerLoop({
        signal: controller.signal,
        once: options.once,
        step: ingestionStep(client, serverUrl),
        onFailure: (error, retryInMs) =>
          console.error(
            `Ingestion paused: ${safeWorkerError(error)}.${retryNote(retryInMs)}`
          ),
      }),
    research: () =>
      runWorkerLoop({
        signal: controller.signal,
        once: options.once,
        step: researchStep(client),
        // Research errors can carry provider output, so only a fixed message is logged.
        onFailure: (_error, retryInMs) =>
          console.error(
            `A research step failed. Saved requests remain available for retry.${retryNote(retryInMs)}`
          ),
      }),
  }
  try {
    console.log(`Blitz worker is ready (${options.loops.join(", ")}).`)
    const results = await Promise.all(options.loops.map((name) => loops[name]()))
    if (results.includes(false)) process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    process.removeListener("unhandledRejection", reportStrayRejection)
  }
}

await main().catch((error) => {
  console.error(`Blitz worker could not start: ${safeWorkerError(error)}.`)
  process.exitCode = 1
})
