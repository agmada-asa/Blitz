/** Runs approval-first research planning jobs on the local Mac through Codex. */

import { randomUUID } from "node:crypto"
import {
  runCodexTextTurn,
  type CardChatEvent,
  type CardChatResult,
} from "./card-chat.ts"
import {
  buildResearchProposalPrompt,
  parseResearchProposal,
  ResearchProposalError,
  type ResearchProposal,
} from "./research-proposal.ts"
import {
  defaultChatWorkspaceDirectory,
  ensureChatWorkspaceDirectory,
} from "./chat-worker.ts"

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
}

/** Options for one proposal planning step. */
export interface ResearchProposalWorkerOptions {
  workerId: string
  workspaceDirectory?: string
  signal?: AbortSignal
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
  try {
    options.signal?.throwIfAborted()
    const prompt = buildResearchProposalPrompt(claim.request)
    const runTurn =
      options.runTurn ??
      (async (turnPrompt, turnOptions) =>
        runCodexTextTurn(
          {
            workspaceDirectory,
            prompt: turnPrompt,
            signal: turnOptions.signal,
            timeoutMs: 120_000,
            ephemeral: true,
            model:
              options.model ?? process.env.BLITZ_CODEX_MODEL ?? "gpt-5.6-luna",
            ...(options.effort === undefined ? {} : { effort: options.effort }),
          },
          { onEvent: turnOptions.onEvent }
        ))
    const result = await runTurn(prompt, {
      signal: options.signal,
      onEvent: options.onEvent,
    })
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
        onEvent: options.onEvent,
      })
      options.signal?.throwIfAborted()
      proposal = parseResearchProposal(repaired.text)
    }
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
