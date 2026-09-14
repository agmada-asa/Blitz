/** Routes one text turn through the selected provider and normalizes its events. */
import type { ProviderApprovalHandler } from "./types.ts"

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
import {
  providerExecutionInstructions,
  resolveProviderExecution,
} from "../../provider-execution.ts"
import { projectApprovalResponse } from "../project-agent-approval.ts"
import {
  runAcpTextTurn,
  AcpProviderError,
  type AcpRequestHandler,
} from "./acp.ts"
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
import {
  getCodexModelCatalog,
  validateCodexModelSelection,
} from "./codex-models.ts"
import type {
  ProviderImageAttachment,
  ProviderModelOption,
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
  /** Optional bounded native image attachments for multimodal providers. */
  readonly attachments?: readonly ProviderImageAttachment[]
  /** Application-owned instructions sent through a provider instruction channel. */
  readonly developerInstructions?: string
  /** Existing provider session to resume. */
  readonly threadId?: string
  /** Whether this turn should use a disposable session. */
  readonly ephemeral?: boolean
  /** Hosted search mode for providers that support it. */
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
  /** Sandbox policy for the selected provider. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Provider approval policy. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never" | "full-access"
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Wall-clock turn deadline. */
  readonly timeoutMs?: number
}

/** Optional transport override used by Codex lifecycle tests. */
export type ProviderTextTurnOptions = {
  /** Receives normalized product events. */
  readonly onEvent?: (event: CardChatEvent) => void
  /** Resolves one interactive native tool request. Omission denies it. */
  readonly approvalHandler?: ProviderApprovalHandler
  /** Handles verified ACP structured elicitation requests with native results. */
  readonly requestHandler?: AcpRequestHandler
  /** Codex-only transport factory retained for existing tests and approval bridges. */
  readonly createCodexTransport?: CardChatTransportFactory
  /** Runtime Codex catalog supplied by a caller that owns a custom transport. */
  readonly codexModelCatalog?: readonly ProviderModelOption[]
}

/** Converts one provider-neutral approval into the exact Codex native response. */
export async function resolveCodexApproval(
  request: { id: string | number; method: string; params?: unknown },
  handler: ProviderApprovalHandler
): Promise<import("../codex-app-server.ts").CodexApprovalResponse> {
  const response = await handler({
    requestId: request.id,
    method: request.method,
    params: request.params,
  })
  const accepted =
    typeof response === "boolean" ? response : response?.accepted === true
  const optionId =
    typeof response === "boolean" ? undefined : response?.optionId
  return projectApprovalResponse(
    {
      id: request.id,
      method: request.method,
      params: request.params,
    },
    accepted,
    optionId
  )
}

/** Converts provider events into the product event shape used by existing chat code. */
function productEvent(event: ProviderEvent): CardChatEvent | undefined {
  switch (event.type) {
    case "turn-started":
      return event
    case "text-delta":
      return event
    case "thought-delta":
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
      error instanceof Error ? error.message : "Provider turn input is invalid",
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
  const execution = resolveProviderExecution({
    providerId: request.providerId,
    workspaceDirectory: request.workspaceDirectory,
    sandbox: request.sandbox,
    approvalPolicy: request.approvalPolicy,
    ephemeral: request.ephemeral,
    webSearchMode: request.webSearchMode,
  })
  const executionInstructions = providerExecutionInstructions(execution)
  const providerRequest: ProviderTextTurnRequest = {
    selection,
    workspaceDirectory: request.workspaceDirectory,
    prompt: request.prompt,
    ...(request.attachments?.length
      ? { attachments: request.attachments }
      : {}),
    developerInstructions: [
      request.developerInstructions?.trim(),
      executionInstructions,
    ]
      .filter(Boolean)
      .join("\n\n"),
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
      if (!options.createCodexTransport || options.codexModelCatalog) {
        let catalog
        if (options.codexModelCatalog) catalog = options.codexModelCatalog
        else {
          try {
            catalog = await getCodexModelCatalog({
              workspaceDirectory: request.workspaceDirectory,
              executable: providerCommand("codex").executable,
              requestTimeoutMs: Math.min(request.timeoutMs ?? 5_000, 5_000),
            })
          } catch (error) {
            throw new CardChatError(
              "transport",
              "Codex model capabilities could not be checked before this turn",
              error
            )
          }
        }
        const selectedModel =
          selection.model === "default"
            ? catalog.find((model) => model.isDefault)
            : catalog.find((model) => model.id === selection.model)
        if (selection.model !== "default" && !selectedModel)
          throw new CardChatError(
            "invalid-input",
            `Codex model is not available: ${selection.model}`
          )
        if (selectedModel) {
          try {
            validateCodexModelSelection(
              catalog,
              {
                model: selectedModel.id,
                ...(selection.effort === undefined
                  ? {}
                  : { effort: selection.effort }),
              },
              Boolean(request.attachments?.length)
            )
          } catch (error) {
            throw new CardChatError(
              "invalid-input",
              error instanceof Error
                ? error.message
                : "Codex model selection is invalid",
              error
            )
          }
        } else if (selection.effort || request.attachments?.length) {
          throw new CardChatError(
            "invalid-input",
            "Codex default model capabilities are unavailable"
          )
        }
      }
      return await runCodexTextTurn(
        {
          approvalPolicy:
            request.approvalPolicy === "full-access"
              ? "never"
              : request.approvalPolicy,
          sandbox: request.sandbox,
          developerInstructions: providerRequest.developerInstructions,
          images: request.attachments?.map((attachment) => ({
            type: "image" as const,
            url: `data:${attachment.mimeType};base64,${attachment.data}`,
          })),
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
          approvalHandler: options.approvalHandler
            ? (serverRequest) =>
                resolveCodexApproval(serverRequest, options.approvalHandler!)
            : undefined,
        }
      )
    }
    const availability = await checkProviderAvailability(request.providerId, {
      workspaceDirectory: request.workspaceDirectory,
      providerInstanceId: request.providerInstanceId,
      signal: request.signal,
    })
    if (!availability.available || availability.authenticated === false)
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
        approvalHandler: options.approvalHandler,
      })
    } else {
      result = await runAcpTextTurn(providerRequest, {
        command: providerCommand(request.providerId),
        providerInstanceId: instanceId,
        onEvent,
        approvalHandler: options.approvalHandler,
        requestHandler: options.requestHandler,
      })
    }
    return {
      threadId: result.threadId,
      turnId: result.turnId,
      text: result.text,
      ...(result.thought ? { thought: result.thought } : {}),
      ...(result.durationMs !== undefined
        ? { durationMs: result.durationMs }
        : {}),
    }
  } catch (error) {
    void getProviderDefinition(request.providerId)
    throw providerError(error)
  }
}
