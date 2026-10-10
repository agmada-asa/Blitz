/** Runs approval-first research planning jobs on the local Mac through Codex. */

import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { type CardChatEvent, type CardChatResult } from "./card-chat.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"
import { getProviderDefinition } from "./providers/registry.ts"
import type { AiProviderId } from "../ai-model-settings.ts"
import {
  buildResearchProposalPrompt,
  parseResearchProposal,
  ResearchProposalError,
  type ResearchActivityEvent,
  type ResearchProposal,
} from "./research-proposal.ts"

/**
 * Returns the stable user-owned provider workspace, outside the repository.
 * `BLITZ_CODEX_WORKSPACE` overrides the default under `~/.local/share`.
 */
export function defaultChatWorkspaceDirectory(): string {
  const configured = process.env.BLITZ_CODEX_WORKSPACE?.trim()
  if (configured) return configured
  return join(homedir(), ".local", "share", "blitz", "codex-workspace")
}

/**
 * Creates the caller-selected workspace directory and returns it.
 * Throws when the path is relative or inside the Blitz repository.
 */
export async function ensureChatWorkspaceDirectory(
  directory: string
): Promise<string> {
  if (!isAbsolute(directory))
    throw new Error("Chat workspace must be an absolute path")
  const resolved = resolve(directory)
  const repository = resolve(process.cwd())
  if (resolved === repository || resolved.startsWith(`${repository}${sep}`))
    throw new Error("Chat workspace must be outside the Blitz repository")
  await mkdir(directory, { recursive: true })
  return directory
}

/** A queued proposal request returned by Convex. */
export interface ResearchProposalClaim {
  /** Persisted proposal record identifier. */
  proposalId: string
  /** Project receiving the proposal. */
  projectId: string
  /** Client idempotency key. */
  requestId: string
  /** Learner's bounded request. */
  request: string
  /** Provider snapshot copied when the proposal was queued. */
  providerId?: AiProviderId
  /** Provider instance snapshot copied when the proposal was queued. */
  providerInstanceId?: string
  /** Model snapshot copied when the proposal was queued. */
  researchModel?: string
  /** Reasoning snapshot copied when the proposal was queued. */
  researchEffort?: string
  /** Capability token for the current lease. */
  leaseToken: string
}

/** Persistence operations needed by one proposal worker step. */
export interface ResearchProposalQueue {
  /** Claims one queued or expired proposal, or returns null. */
  claimNext(args: {
    workerId: string
    leaseToken: string
  }): Promise<ResearchProposalClaim | null>
  /** Commits a validated proposal while the lease is live. */
  complete(args: {
    proposalId: string
    leaseToken: string
    proposal: ResearchProposal
  }): Promise<unknown>
  /** Records a generic safe failure while preserving retry state. */
  fail(args: {
    proposalId: string
    leaseToken: string
    error: string
  }): Promise<unknown>
  /** Appends one bounded observable activity event while the lease is live. */
  recordActivity?(args: {
    proposalId: string
    leaseToken: string
    event: ResearchActivityEvent
  }): Promise<unknown>
}

/** Options for one proposal planning step. */
export interface ResearchProposalWorkerOptions {
  workerId: string
  workspaceDirectory?: string
  signal?: AbortSignal
  /** Provider selected when the proposal was queued. */
  providerId?: AiProviderId
  /** Optional local account or profile selected with the provider. */
  providerInstanceId?: string
  model?: string
  effort?: string
  queue: ResearchProposalQueue
  /** Injectable text runner for validation and lifecycle tests. */
  runTurn?: (
    prompt: string,
    options: { signal?: AbortSignal; onEvent?: (event: CardChatEvent) => void }
  ) => Promise<Pick<CardChatResult, "text">>
  /** Receives retained Codex activity without changing proposal persistence. */
  onEvent?: (event: CardChatEvent) => void
}

/** Result returned after one proposal queue poll. */
export type ResearchProposalStepResult =
  | { status: "idle" }
  | {
      status: "ready"
      proposalId: string
      projectId: string
      proposal: ResearchProposal
    }
  | {
      status: "failed"
      proposalId: string
      projectId: string
      failureKind: "invalid-output" | "transport"
      failureDetail?: string
    }

/** Returns a generic persisted failure that cannot leak model or source data. */
function safeFailure(): string {
  return "Research proposal could not be prepared. Retry to try again."
}

/** Builds one bounded repair prompt after proposal JSON validation fails. */
function buildRepairPrompt(
  prompt: string,
  error: ResearchProposalError
): string {
  return `${prompt}
The previous response failed Blitz's proposal format validation. Return a corrected JSON object only; do not explain the correction and do not use a markdown fence.
Validation category: ${error.code}. Validation detail: ${error.message.slice(0, 200)}
The corrected object must have exactly these fields: scope (a non-empty string of at most 100 words), topics (an array of 1-12 non-empty strings, with unique names), sources (an array of source objects), and generatedNotes (an array of note-outline objects).
Each source object must contain url, title, reason, verification, where verification is exactly "suggested-unverified". Each generatedNotes object must contain label exactly "generated", title, description, and reason. Use empty arrays only where allowed, and include at least one source or note outline.`
}

/** Claims, plans, validates, and atomically saves one research proposal. */
export async function runResearchProposalStep(
  options: ResearchProposalWorkerOptions
): Promise<ResearchProposalStepResult> {
  if (!options.workerId.trim())
    throw new Error("Research worker id is required")
  options.signal?.throwIfAborted()
  const workspaceDirectory =
    options.workspaceDirectory ?? defaultChatWorkspaceDirectory()
  await ensureChatWorkspaceDirectory(workspaceDirectory)
  const leaseToken = randomUUID()
  const claim = await options.queue.claimNext({
    workerId: options.workerId,
    leaseToken,
  })
  if (!claim) return { status: "idle" }
  const activityStartedAt = Date.now()
  const activityWrites: Promise<unknown>[] = []
  try {
    options.signal?.throwIfAborted()
    const providerId = claim.providerId ?? options.providerId ?? "codex"
    const providerInstanceId =
      claim.providerInstanceId ?? options.providerInstanceId
    const model =
      claim.researchModel ??
      options.model ??
      process.env.BLITZ_CODEX_MODEL ??
      "gpt-6-luna"
    const effort = claim.researchEffort ?? options.effort
    if (
      !options.runTurn &&
      !getProviderDefinition(providerId).capabilities.webSearch
    )
      throw new Error("The selected provider does not support web search")
    /** Persists and forwards one safe lifecycle event without blocking the turn. */
    const emitActivity = (
      event: Omit<ResearchActivityEvent, "occurredAt" | "elapsedMs">
    ): void => {
      const safeEvent: ResearchActivityEvent = {
        ...event,
        occurredAt: Date.now(),
        elapsedMs: Math.max(0, Date.now() - activityStartedAt),
      }
      const write = options.queue.recordActivity?.({
        proposalId: claim.proposalId,
        leaseToken,
        event: safeEvent,
      })
      if (write) activityWrites.push(write.catch(() => undefined))
      options.onEvent?.({
        type: "activity",
        notification: {
          method: "research/activity",
          params: safeEvent,
        },
      })
    }
    emitActivity({ stage: "running", label: "Preparing research" })
    const prompt = buildResearchProposalPrompt(claim.request)
    const runTurn =
      options.runTurn ??
      (async (turnPrompt, turnOptions) =>
        runProviderTextTurn(
          {
            providerId,
            ...(providerInstanceId ? { providerInstanceId } : {}),
            workspaceDirectory,
            prompt: turnPrompt,
            signal: turnOptions.signal,
            timeoutMs: 120_000,
            ephemeral: true,
            webSearchMode: "live",
            sandbox: "read-only",
            approvalPolicy: "never",
            model,
            ...(effort === undefined ? {} : { effort }),
          },
          { onEvent: turnOptions.onEvent }
        ))
    let webSearchCount = 0
    /** Records hosted search completion events while preserving caller activity. */
    const handleTurnEvent = (event: CardChatEvent): void => {
      if (
        event.type === "activity" &&
        "notification" in event &&
        event.notification.method === "item/completed" &&
        typeof event.notification.params === "object" &&
        event.notification.params !== null &&
        !Array.isArray(event.notification.params) &&
        typeof (event.notification.params as { item?: unknown }).item ===
          "object" &&
        (event.notification.params as { item?: { type?: unknown } }).item
          ?.type === "webSearch"
      ) {
        webSearchCount += 1
        const item = (
          event.notification.params as { item?: Record<string, unknown> }
        ).item
        const action = item?.action as Record<string, unknown> | undefined
        const rawQuery = action?.query
        const rawQueries = action?.queries
        const query =
          typeof rawQuery === "string"
            ? rawQuery
            : Array.isArray(rawQueries)
              ? rawQueries
                  .filter((value): value is string => typeof value === "string")
                  .join("; ")
              : undefined
        emitActivity({
          stage: "searching",
          label: "Searching the web",
          tool: "web_search",
          ...(query === undefined ? {} : { query: query.slice(0, 500) }),
        })
      }
      options.onEvent?.(event)
    }
    const result = await runTurn(prompt, {
      signal: options.signal,
      onEvent: handleTurnEvent,
    })
    emitActivity({ stage: "synthesizing", label: "Preparing the proposal" })
    options.signal?.throwIfAborted()
    let proposal: ResearchProposal
    try {
      proposal = parseResearchProposal(result.text)
    } catch (error) {
      if (
        !(error instanceof ResearchProposalError) ||
        error.code !== "invalid-output"
      )
        throw error
      // Repair malformed model JSON once; transport failures remain non-retryable here.
      const repaired = await runTurn(buildRepairPrompt(prompt, error), {
        signal: options.signal,
        onEvent: handleTurnEvent,
      })
      options.signal?.throwIfAborted()
      proposal = parseResearchProposal(repaired.text)
    }
    if (proposal.sources.length > 0 && webSearchCount === 0) {
      throw new ResearchProposalError(
        "invalid-output",
        "Research proposal contained sources without a hosted web search"
      )
    }
    emitActivity({ stage: "completed", label: "Research proposal ready" })
    await Promise.all(activityWrites)
    await options.queue.complete({
      proposalId: claim.proposalId,
      leaseToken,
      proposal,
    })
    return {
      status: "ready",
      proposalId: claim.proposalId,
      projectId: claim.projectId,
      proposal,
    }
  } catch (error) {
    const failedActivity: ResearchActivityEvent = {
      stage: "failed",
      label: "Research proposal failed",
      occurredAt: Date.now(),
      elapsedMs: Math.max(0, Date.now() - activityStartedAt),
    }
    if (options.queue.recordActivity) {
      await options.queue
        .recordActivity({
          proposalId: claim.proposalId,
          leaseToken,
          event: failedActivity,
        })
        .catch(() => undefined)
    }
    await options.queue
      .fail({ proposalId: claim.proposalId, leaseToken, error: safeFailure() })
      .catch(() => undefined)
    if (options.signal?.aborted)
      throw new Error("Research proposal was interrupted")
    return {
      status: "failed",
      proposalId: claim.proposalId,
      projectId: claim.projectId,
      failureKind:
        error instanceof ResearchProposalError ? "invalid-output" : "transport",
      ...(error instanceof ResearchProposalError
        ? { failureDetail: error.message.slice(0, 200) }
        : {}),
    }
  }
}
