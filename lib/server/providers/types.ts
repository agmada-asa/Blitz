/** Defines the server-only contracts shared by Blitz provider adapters. */

import type {
  AiProviderId,
  AiReasoningEffort,
  AiTask,
} from "../../ai-model-settings.ts"

/** Native image content validated from a stored upload before provider dispatch. */
export interface ProviderImageAttachment {
  readonly type: "image"
  /** MIME type verified by the upload boundary. */
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  /** Base64 image bytes, never a client-controlled local path. */
  readonly data: string
  /** Original display name retained for attachment context. */
  readonly name: string
}

/** Shared capabilities used by both the browser and server, with no duplicate provider catalog. */
export type { ChatProviderCapabilities as ProviderCapabilities } from "../../provider-capabilities.ts"
import type { ChatProviderCapabilities as ProviderCapabilities } from "../../provider-capabilities.ts"

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
  /** Whether the installed runtime currently has credentials it can use. */
  readonly authenticated: boolean | null
  /** Login choices reported by the provider, when it exposes them safely. */
  readonly authMethods?: readonly ProviderAuthMethod[]
  /** Configured account names that the provider allows Blitz to disconnect. */
  readonly accounts?: readonly string[]
  /** Whether Blitz can ask the provider to clear its current credentials. */
  readonly canDisconnect?: boolean
  /** Models reported by the provider's authenticated runtime session. */
  readonly models?: readonly ProviderModelOption[]
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

/** One provider-owned model choice, including reasoning encoded in its native ID. */
export interface ProviderModelOption {
  /** Opaque value sent back through the provider's session configuration. */
  readonly id: string
  /** Human-readable name supplied by the provider. */
  readonly label: string
  /** Reasoning level represented by this exact provider choice, when recognizable. */
  readonly reasoningEffort?: AiReasoningEffort
  /** All native reasoning levels exposed by this exact runtime model. */
  readonly reasoningEfforts?: readonly AiReasoningEffort[]
  /** Input modalities accepted by this exact runtime model. */
  readonly inputModalities?: readonly ("text" | "image" | "audio")[]
  /** Whether the runtime selected this model as its default model. */
  readonly isDefault?: boolean
}

/** One provider-owned authentication choice displayed without credential data. */
export interface ProviderAuthMethod {
  /** Opaque provider method identifier sent back only to that provider. */
  readonly id: string
  /** Human-readable method name supplied by the provider. */
  readonly name: string
  /** Optional provider explanation of the login method. */
  readonly description?: string
  /** Whether authentication runs through ACP or needs an interactive terminal. */
  readonly type: "agent" | "terminal"
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
  /** Native images kept separate from the textual prompt. */
  readonly attachments?: readonly ProviderImageAttachment[]
  /** Application instructions sent through a native instruction channel when available. */
  readonly developerInstructions?: string
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
      readonly type: "thought-delta"
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
  /** Cumulative thought, reasoning, or commentary trace for the turn. */
  readonly thought?: string
  /** Elapsed turn duration in milliseconds. */
  readonly durationMs?: number
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
export type ProviderApprovalDecision =
  | boolean
  | {
      /** Whether this provider operation is accepted. */
      readonly accepted: boolean
      /** Exact provider option selected by the user, when applicable. */
      readonly optionId?: string
      /** Structured response payload for provider-specific prompts. */
      readonly response?: string
    }

/** Reviews one bounded provider operation and preserves its native identity. */
export type ProviderApprovalHandler = (request: {
  /** Native provider request ID used to correlate the eventual response. */
  readonly requestId?: string | number
  readonly method: string
  readonly params: unknown
  /** Cancels this review independently of the surrounding turn. */
  readonly signal?: AbortSignal
}) => Promise<ProviderApprovalDecision>
