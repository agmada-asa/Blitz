/** Drains persisted card-chat requests on the local Mac through the selected provider. */

import { createChatProgress } from "./chat-progress.ts"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { normalizeSourceDocument } from "./source-ingestion/normalize.ts"
import { segmentSourceDocument } from "./source-ingestion/segment.ts"
import {
  buildCardChatPrompt,
  type CardChatRequest,
  type CardChatEvent,
  type CardChatResult,
} from "./card-chat.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"
import type { AiProviderId } from "../ai-model-settings.ts"

/** Worker-facing queue claim returned by Convex. */
export interface ChatClaim {
  /** Persisted user message being processed. */
  messageId: string
  /** Persisted conversation containing the message. */
  conversationId: string
  /** Project containing the selected learning item. */
  projectId: string
  /** Selected learning item. */
  itemId: string
  /** Previously saved Codex thread, if this is a resumed legacy conversation. */
  codexThreadId: string | null
  /** Provider snapshot for this card conversation. */
  providerId?: AiProviderId
  /** Provider instance snapshot for this card conversation. */
  providerInstanceId?: string | null
  /** Provider-owned session to resume, when the provider exposes one. */
  providerSessionId?: string | null
  /** Model snapshot copied when this conversation was queued. */
  providerModel?: string | null
  /** Reasoning snapshot copied when this conversation was queued. */
  providerEffort?: string | null
  /** Lease token that must accompany every write for this request. */
  leaseToken: string
  /** Learner-authored question. */
  question: string
}

/** Real card and source context loaded only for a live claim. */
export interface ChatWorkContext {
  projectId: string
  itemId: string
  item: {
    id: string
    title: string
    body: string
    question?: string
    options?: string[]
    sourceLabel: string
  }
  source: {
    id: string
    filename: string
    kind: "pdf" | "markdown" | "text" | "paste"
    extractedText: string
    chunkOrdinal: number
    chunkId: string
  }
  question: string
}

/** Persistence calls required by one worker step, injectable for lifecycle tests. */
export interface ChatWorkerQueue {
  /** Claims the oldest queued or expired request, or returns null. */
  claimNext(args: {
    workerId: string
    leaseToken: string
  }): Promise<ChatClaim | null>
  /** Loads the selected card and its bounded source snapshot for a live lease. */
  getWorkContext(args: {
    messageId: string
    leaseToken: string
  }): Promise<ChatWorkContext>
  /** Saves a cumulative partial reply while the lease is live. */
  progress(args: {
    messageId: string
    leaseToken: string
    reply: string
  }): Promise<unknown>
  /** Saves assistant output and provider identifiers atomically. */
  complete(args: {
    messageId: string
    leaseToken: string
    providerId?: AiProviderId
    providerInstanceId?: string
    providerSessionId?: string
    providerTurnId?: string
    codexThreadId?: string
    codexTurnId?: string
    reply: string
  }): Promise<unknown>
  /** Stores a bounded failure while keeping the original message retryable. */
  fail(args: {
    messageId: string
    leaseToken: string
    error: string
  }): Promise<unknown>
}

/** Result of one poll and turn attempt. */
export type ChatWorkerStepResult =
  | { status: "idle" }
  | {
      status: "completed"
      messageId: string
      conversationId: string
      result: CardChatResult
    }
  | { status: "failed"; messageId: string; conversationId: string }

/** Options controlling one local worker step. */
export interface ChatWorkerOptions {
  workerId: string
  workspaceDirectory: string
  signal?: AbortSignal
  model?: string
  effort?: string
  /** Compatibility provider when a legacy claim has no provider snapshot. */
  providerId?: AiProviderId
  /** Compatibility provider instance when a legacy claim has no snapshot. */
  providerInstanceId?: string
  queue: ChatWorkerQueue
  /** Injectable runner used to test queue lifecycle without a provider process. */
  runTurn?: (
    request: CardChatRequest,
    options: { onEvent: (event: CardChatEvent) => void }
  ) => Promise<CardChatResult>
  /** Receives activity while the worker processes a request. */
  onEvent?: (event: CardChatEvent) => void
}

/** Returns the stable user-owned workspace used by chat turns, outside the repository. */
export function defaultChatWorkspaceDirectory(): string {
  const configured = process.env.BLITZ_CODEX_WORKSPACE?.trim()
  if (configured) return configured
  return join(homedir(), ".local", "share", "blitz", "codex-workspace")
}

/** Validates and creates the caller-selected stable workspace directory. */
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

/** Bounds diagnostics before they are persisted in Convex. */
function safeFailure(): string {
  return "Card chat could not complete. Retry to try again."
}

/** Runs one queue claim, source attachment, provider turn, and atomic completion. */
export async function runChatWorkerStep(
  options: ChatWorkerOptions
): Promise<ChatWorkerStepResult> {
  if (!options.workerId.trim()) throw new Error("Chat worker id is required")
  options.signal?.throwIfAborted()
  await ensureChatWorkspaceDirectory(options.workspaceDirectory)
  const leaseToken = randomUUID()
  const claim = await options.queue.claimNext({
    workerId: options.workerId,
    leaseToken,
  })
  if (!claim) return { status: "idle" }
  const progress = createChatProgress((reply) =>
    options.queue.progress({ messageId: claim.messageId, leaseToken, reply })
  )
  try {
    options.signal?.throwIfAborted()
    const context = await options.queue.getWorkContext({
      messageId: claim.messageId,
      leaseToken,
    })
    if (
      context.projectId !== claim.projectId ||
      context.itemId !== claim.itemId ||
      context.question !== claim.question
    )
      throw new Error("Chat queue context changed while leased")
    const source = normalizeSourceDocument({
      sourceId: context.source.id,
      filename: context.source.filename,
      kind: context.source.kind === "paste" ? "text" : context.source.kind,
      text: context.source.extractedText,
    })
    const chunks = segmentSourceDocument(source, {
      chunkSize: 5_000,
      overlap: 400,
    })
    const chunk = chunks[context.source.chunkOrdinal]
    if (!chunk || chunk.id !== context.source.chunkId)
      throw new Error(
        "Card source chunk no longer matches its preparation snapshot"
      )
    const providerId =
      claim.providerId ??
      (claim.codexThreadId ? "codex" : (options.providerId ?? "codex"))
    const providerInstanceId =
      claim.providerInstanceId ?? options.providerInstanceId
    const runTurn =
      options.runTurn ??
      ((request, turnOptions) =>
        runProviderTextTurn(
          {
            providerId,
            ...(providerInstanceId ? { providerInstanceId } : {}),
            workspaceDirectory: request.workspaceDirectory,
            prompt: buildCardChatPrompt(request),
            ...(request.threadId ? { threadId: request.threadId } : {}),
            ...(request.model ? { model: request.model } : {}),
            ...(request.effort ? { effort: request.effort } : {}),
            signal: request.signal,
            sandbox: "read-only",
            approvalPolicy: "never",
          },
          { onEvent: turnOptions.onEvent }
        ))
    const result = await runTurn(
      {
        workspaceDirectory: options.workspaceDirectory,
        threadId: claim.providerSessionId ?? claim.codexThreadId ?? undefined,
        question: claim.question,
        card: context.item,
        source: {
          id: context.source.id,
          filename: context.source.filename,
          extractedText: chunk.text,
        },
        model:
          claim.providerModel ??
          options.model ??
          process.env.BLITZ_CODEX_MODEL ??
          "gpt-5.6-luna",
        ...((claim.providerEffort ?? options.effort)
          ? { effort: claim.providerEffort ?? options.effort }
          : {}),
        signal: options.signal,
      },
      {
        onEvent: (event) => {
          if (event.type === "text-delta") progress.append(event.delta)
          options.onEvent?.(event)
        },
      }
    )
    options.signal?.throwIfAborted()
    await progress.finish()
    await options.queue.complete({
      messageId: claim.messageId,
      leaseToken,
      providerId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
      providerSessionId: result.threadId,
      providerTurnId: result.turnId,
      ...(providerId === "codex"
        ? { codexThreadId: result.threadId, codexTurnId: result.turnId }
        : {}),
      reply: result.text,
    })
    return {
      status: "completed",
      messageId: claim.messageId,
      conversationId: claim.conversationId,
      result,
    }
  } catch (error) {
    await progress.finish()
    await options.queue
      .fail({ messageId: claim.messageId, leaseToken, error: safeFailure() })
      .catch(() => undefined)
    if (options.signal?.aborted) throw error
    return {
      status: "failed",
      messageId: claim.messageId,
      conversationId: claim.conversationId,
    }
  }
}

/** Repeatedly drains the local queue until interrupted, with bounded backoff while offline. */
export async function runChatWorker(
  options: ChatWorkerOptions & { pollMs?: number }
): Promise<void> {
  const pollMs = options.pollMs ?? 3_000
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000)
    throw new Error("Chat worker pollMs must be between 100 and 60000")
  while (!options.signal?.aborted) {
    const result = await runChatWorkerStep(options)
    if (result.status === "idle")
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
          reject(options.signal?.reason ?? new Error("Chat worker interrupted"))
        }
        const onTimer = (): void => {
          options.signal?.removeEventListener("abort", onAbort)
          resolve()
        }
        const timer = setTimeout(onTimer, pollMs)
        options.signal?.addEventListener("abort", onAbort, { once: true })
      }).catch(() => undefined)
  }
}
