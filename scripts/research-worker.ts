/** Starts the local worker that produces approval-first research proposals. */

import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { setTimeout as pause } from "node:timers/promises"
import { ConvexHttpClient } from "convex/browser"
import { api } from "../convex/_generated/api.js"
import type { Id } from "../convex/_generated/dataModel.js"
import { defaultChatWorkspaceDirectory } from "../lib/server/chat-worker.ts"
import {
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

/** Connects Convex and drains one or all queued proposal requests. */
async function main(): Promise<void> {
  loadLocalEnvironment()
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint)
    throw new Error("Set BLITZ_CONVEX_URL before starting the research worker")
  const client = new ConvexHttpClient(endpoint)
  const controller = new AbortController()
  const workerId = `blitz-research-${randomUUID()}`
  const once = process.argv.includes("--once")
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const queue: ResearchProposalQueue & ResearchImportQueue = {
    claimNext: async (args): Promise<ResearchProposalClaim | null> =>
      client.mutation(api.research.claimNext, args),
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
        ...(args.partNumber === undefined ? {} : { partNumber: args.partNumber }),
        ...(args.totalParts === undefined ? {} : { totalParts: args.totalParts }),
      }),
    failImport: (args) =>
      client.mutation(api.research.failImport, {
        importId: args.importId as Id<"researchProposalImports">,
        leaseToken: args.leaseToken,
        failureCategory: args.failureCategory as ResearchImportFailureCategory,
      }),
  }
  try {
    console.log("Blitz research worker is ready.")
    while (!controller.signal.aborted) {
      try {
        const importResult = await runResearchImportStep({
          queue,
          workerId,
          signal: controller.signal,
        })
        const settings =
          importResult.status === "idle"
            ? await loadSavedAiModelSettings(client)
            : null
        const result =
          importResult.status === "idle"
            ? await runResearchProposalStep({
                queue,
                workerId,
                workspaceDirectory: defaultChatWorkspaceDirectory(),
                signal: controller.signal,
                model: resolveAiModel(
                  settings,
                  "researchModel",
                  process.env.BLITZ_CODEX_MODEL
                ),
                effort: resolveAiReasoningEffort(
                  settings,
                  "researchEffort",
                  process.env.BLITZ_CODEX_EFFORT
                ),
              })
            : null
        if (importResult.status === "imported")
          console.log(
            `Imported approved research source ${importResult.importId}.`
          )
        if (importResult.status === "failed")
          console.error(
            `Approved research source ${importResult.importId} failed (${importResult.failureCategory}); retry it deliberately.`
          )
        if (result?.status === "ready")
          console.log(`Prepared research proposal ${result.proposalId}.`)
        if (result?.status === "failed")
          console.error(
            `Research proposal ${result.proposalId} failed (${result.failureKind}${result.failureDetail ? `: ${result.failureDetail}` : ""}); retry it deliberately.`
          )
        if (once) break
        if (importResult.status === "idle" && result?.status === "idle")
          await pause(3_000, undefined, { signal: controller.signal })
      } catch {
        if (controller.signal.aborted) break
        console.error(
          "A research proposal step failed. Saved requests remain available for retry."
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
    "Blitz research worker could not start. Check the local server and configuration."
  )
  process.exitCode = 1
})
