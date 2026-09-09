/** Defines the server-only contracts shared by Blitz provider adapters. */

import type {
  AiProviderId,
  AiReasoningEffort,
  AiTask,
} from "../../ai-model-settings.ts"

/** Capabilities that change how Blitz may route a task through a provider. */
export interface ProviderCapabilities {
  /** Whether the adapter can stream assistant text while a turn runs. */
  readonly streaming: boolean
  /** Whether the adapter can resume a provider-owned session. */
  readonly resumableSessions: boolean
  /** Whether the provider can return schema-constrained JSON safely. */
  readonly structuredOutput: boolean
  /** Whether the adapter can surface interactive approval requests. */
  readonly approvals: boolean
  /** Whether a turn may request hosted or provider-native web search. */
  readonly webSearch: boolean
  /** Whether the provider can write inside Blitz's selected workspace. */
  readonly workspaceWrites: boolean
  /** Whether a session can switch models without being recreated. */
  readonly sessionModelSwitch: boolean
  /** Whether a provider session supports promptless continuation. */
  readonly promptlessTurnContinuation: boolean
  /** Whether the provider can roll a conversation back to a checkpoint. */
  readonly conversationRollback: boolean
}

/** A local provider command and optional arguments used by health checks. */
export interface ProviderCommand {
  /** Executable name or absolute path resolved by the operating system. */
  readonly executable: string
  /** Arguments needed to start the provider's local protocol. */
  readonly args: readonly string[]
}

/** Current local setup state for one provider instance. */
export interface ProviderAvailability {
  /** Provider being checked. */
  readonly providerId: AiProviderId
  /** Stable local profile or configuration key. */
  readonly providerInstanceId: string
  /** Whether a turn can start with this configuration. */
  readonly available: boolean
  /** Safe reason shown in setup or recovery UI. */
  readonly reason?:
    | "ready"
    | "missing-executable"
    | "missing-auth"
    | "unsupported"
    | "probe-failed"
  /** User-safe setup detail without command output or credentials. */
  readonly message: string
}

/** Provider selection resolved for one immutable task or chat snapshot. */
export interface ProviderSelection {
  /** Provider integration selected for the task. */
  readonly providerId: AiProviderId
  /** Optional local account or profile key. */
  readonly providerInstanceId?: string
  /** Provider-specific model identifier. */
  readonly model: string
  /** Provider-neutral reasoning level when supported. */
  readonly effort?: AiReasoningEffort
}

/** A provider session reference safe to persist in Convex. */
export interface ProviderSessionReference {
  /** Provider integration that owns the session. */
  readonly providerId: AiProviderId
  /** Provider instance or profile that owns the session. */
  readonly providerInstanceId?: string
  /** Provider-issued session identifier. */
  readonly providerSessionId: string
  /** Provider-issued resume cursor when its protocol exposes one. */
  readonly resumeCursor?: string
}

/** Provider request shared by chat, research, and structured generation. */
export interface ProviderTextTurnRequest {
  /** Provider selection for this immutable turn. */
  readonly selection: ProviderSelection
  /** Absolute workspace the provider may inspect or write. */
  readonly workspaceDirectory: string
  /** Bounded prompt text. */
  readonly prompt: string
  /** Existing provider session to resume. */
  readonly session?: ProviderSessionReference
  /** Whether the provider should avoid retaining a disposable session. */
  readonly ephemeral?: boolean
  /** Requested hosted search mode, when the provider supports it. */
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
  /** Safe sandbox policy for interactive providers. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Whether the provider may ask the user for an approval. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never" | "full-access"
  /** Cancellation signal owned by the route or worker. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline for the complete provider turn. */
  readonly timeoutMs?: number
}

/** Normalized provider event consumed by product-level orchestration. */
export type ProviderEvent =
  | {
      readonly type: "turn-started"
      readonly threadId: string
      readonly turnId: string
    }
  | {
      readonly type: "text-delta"
      readonly threadId: string
      readonly turnId: string
      readonly delta: string
    }
  | {
      readonly type: "activity"
      readonly method: string
      readonly params?: unknown
    }
  | {
      readonly type: "request"
      readonly requestId: string | number
      readonly method: string
      readonly params?: unknown
    }

/** Result of one normalized provider text turn. */
export interface ProviderTextTurnResult {
  /** Provider integration that produced the response. */
  readonly providerId: AiProviderId
  /** Provider instance that produced the response. */
  readonly providerInstanceId: string
  /** Session identifier safe to persist for later turns. */
  readonly threadId: string
  /** Turn identifier safe to associate with one message. */
  readonly turnId: string
  /** Complete assistant text. */
  readonly text: string
}

/** Input required to check a provider before showing it as available. */
export interface ProviderHealthOptions {
  /** Local workspace used only for a non-authenticating protocol probe. */
  readonly workspaceDirectory: string
  /** Optional local instance/profile key. */
  readonly providerInstanceId?: string
  /** Abort signal for a bounded health check. */
  readonly signal?: AbortSignal
}

/** One provider adapter registered in the server-side registry. */
export interface ProviderAdapterDefinition {
  /** Stable provider integration identifier. */
  readonly providerId: AiProviderId
  /** Visible provider name used by diagnostics. */
  readonly displayName: string
  /** Tasks supported by this adapter when its runtime is ready. */
  readonly tasks: readonly AiTask[]
  /** Capability snapshot used before a local runtime probe. */
  readonly capabilities: ProviderCapabilities
  /** Returns whether the local runtime can accept a turn. */
  readonly checkAvailability: (
    options: ProviderHealthOptions
  ) => Promise<ProviderAvailability>
}

/** Reviews one bounded provider operation; true grants only this invocation. */
export type ProviderApprovalHandler = (request: {
  readonly method: string
  readonly params: unknown
  /** Cancels this review independently of the surrounding turn. */
  readonly signal?: AbortSignal
}) => Promise<boolean>
