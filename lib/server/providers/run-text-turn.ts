/** Routes one text turn through the selected provider and normalizes its events. */

import {
  CardChatError,
  runCodexTextTurn,
  type CardChatEvent,
  type CardChatResult,
  type CardChatTransportFactory,
} from "../card-chat.ts"
import type {
  AiProviderId,
  AiReasoningEffort,
} from "../../ai-model-settings.ts"
import { runAcpTextTurn, AcpProviderError } from "./acp.ts"
import {
  ClaudeCodeProviderError,
  runClaudeCodeTextTurn,
} from "./claude-code.ts"
import {
  checkProviderAvailability,
  getProviderDefinition,
  providerCommand,
  providerInstanceId,
} from "./registry.ts"
import type {
  ProviderEvent,
  ProviderSelection,
  ProviderTextTurnRequest,
  ProviderTextTurnResult,
} from "./types.ts"

/** Provider-aware text request accepted by chat and generation callers. */
export interface RunProviderTextTurnRequest {
  /** Provider integration selected for this turn. */
  readonly providerId: AiProviderId
  /** Optional local account or profile key. */
  readonly providerInstanceId?: string
  /** Provider model identifier. */
  readonly model?: string
  /** Provider-neutral reasoning level. */
  readonly effort?: string
  /** Absolute workspace used by the provider. */
  readonly workspaceDirectory: string
  /** Bounded prompt text. */
  readonly prompt: string
  /** Existing provider session to resume. */
  readonly threadId?: string
  /** Whether this turn should use a disposable session. */
  readonly ephemeral?: boolean
  /** Hosted search mode for providers that support it. */
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
  /** Sandbox policy for the selected provider. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Provider approval policy. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never"
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Wall-clock turn deadline. */
  readonly timeoutMs?: number
}

/** Optional transport override used by Codex lifecycle tests. */
export type ProviderTextTurnOptions = {
  /** Receives normalized product events. */
  readonly onEvent?: (event: CardChatEvent) => void
  /** Codex-only transport factory retained for existing tests and approval bridges. */
  readonly createCodexTransport?: CardChatTransportFactory
}

/** Converts provider events into the product event shape used by existing chat code. */
function productEvent(event: ProviderEvent): CardChatEvent | undefined {
  switch (event.type) {
    case "turn-started":
      return event
    case "text-delta":
      return event
    case "activity":
      return {
        type: "activity",
        notification: { method: event.method, params: event.params },
      }
    case "request":
      return {
        type: "activity",
        serverRequest: {
          id: event.requestId,
          method: event.method,
          params: event.params,
        },
      }
  }
}

/** Converts a provider runtime error into stable Blitz recovery copy. */
function providerError(error: unknown): CardChatError {
  if (error instanceof CardChatError) return error
  const code =
    error instanceof AcpProviderError ||
    error instanceof ClaudeCodeProviderError
      ? error.code
      : undefined
  if (code === "aborted")
    return new CardChatError("aborted", "Provider turn was interrupted", error)
  if (code === "timeout")
    return new CardChatError("timeout", "Provider turn timed out", error)
  if (code === "invalid-input")
    return new CardChatError(
      "invalid-input",
      "Provider turn input is invalid",
      error
    )
  return new CardChatError(
    "transport",
    "The selected provider could not finish this turn",
    error
  )
}

/** Runs the selected provider and returns the result shape expected by Blitz features. */
export async function runProviderTextTurn(
  request: RunProviderTextTurnRequest,
  options: ProviderTextTurnOptions = {}
): Promise<CardChatResult> {
  const selection: ProviderSelection = {
    providerId: request.providerId,
    ...(request.providerInstanceId
      ? { providerInstanceId: request.providerInstanceId }
      : {}),
    model: request.model?.trim() || "default",
    ...(request.effort?.trim()
      ? { effort: request.effort.trim() as AiReasoningEffort }
      : {}),
  }
  const providerRequest: ProviderTextTurnRequest = {
    selection,
    workspaceDirectory: request.workspaceDirectory,
    prompt: request.prompt,
    ...(request.threadId
      ? {
          session: {
            providerId: request.providerId,
            ...(request.providerInstanceId
              ? { providerInstanceId: request.providerInstanceId }
              : {}),
            providerSessionId: request.threadId,
          },
        }
      : {}),
    ...(request.ephemeral === undefined
      ? {}
      : { ephemeral: request.ephemeral }),
    ...(request.webSearchMode === undefined
      ? {}
      : { webSearchMode: request.webSearchMode }),
    ...(request.sandbox === undefined ? {} : { sandbox: request.sandbox }),
    ...(request.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: request.approvalPolicy }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
  }
  try {
    if (request.providerId === "codex") {
      return await runCodexTextTurn(
        {
          approvalPolicy: request.approvalPolicy,
          workspaceDirectory: request.workspaceDirectory,
          prompt: request.prompt,
          ...(request.threadId ? { threadId: request.threadId } : {}),
          ...(request.ephemeral === undefined
            ? {}
            : { ephemeral: request.ephemeral }),
          ...(selection.model === "default" ? {} : { model: selection.model }),
          ...(selection.effort === undefined
            ? {}
            : { effort: selection.effort }),
          ...(request.webSearchMode === undefined
            ? {}
            : { webSearchMode: request.webSearchMode }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
        },
        {
          createTransport: options.createCodexTransport,
          onEvent: options.onEvent,
        }
      )
    }
    const availability = await checkProviderAvailability(request.providerId, {
      workspaceDirectory: request.workspaceDirectory,
      providerInstanceId: request.providerInstanceId,
      signal: request.signal,
    })
    if (!availability.available)
      throw new CardChatError("transport", availability.message)
    getProviderDefinition(request.providerId)
    const instanceId =
      request.providerInstanceId ?? providerInstanceId(request.providerId)
    let result: ProviderTextTurnResult
    const onEvent = (event: ProviderEvent): void => {
      const normalized = productEvent(event)
      if (normalized) options.onEvent?.(normalized)
    }
    if (request.providerId === "claude-code") {
      result = await runClaudeCodeTextTurn(providerRequest, {
        command: providerCommand(request.providerId),
        providerInstanceId: instanceId,
        onEvent,
      })
    } else {
      result = await runAcpTextTurn(providerRequest, {
        command: providerCommand(request.providerId),
        providerInstanceId: instanceId,
        onEvent,
      })
    }
    return {
      threadId: result.threadId,
      turnId: result.turnId,
      text: result.text,
    }
  } catch (error) {
    void getProviderDefinition(request.providerId)
    throw providerError(error)
  }
}
