/** Describes adapter support for both the chat UI and server routing, independently of account access. */
import {
  AI_PROVIDER_APPROVAL_POLICIES,
  getSupportedAiReasoningEffortsForProvider,
  type AiApprovalPolicy,
  type AiProviderId,
} from "./ai-model-settings.ts"

/** Support that must be negotiated with a running provider must never be treated as an unconditional grant. */
export type CapabilitySupport = "supported" | "negotiated" | "unsupported"

/** Adapter features, distinct from the permissions of an individual turn or installed model. */
export interface ChatProviderCapabilities {
  readonly streaming: boolean
  readonly resumableSessions: boolean
  /** Whether the adapter requests native schema-constrained output. JSON validation alone is insufficient. */
  readonly structuredOutput: boolean
  readonly approvals: boolean
  readonly webSearch: boolean
  readonly workspaceWrites: boolean
  readonly sessionModelSwitch: boolean
  readonly promptlessTurnContinuation: boolean
  readonly conversationRollback: boolean
  /** Files currently enter the model as extracted text; originals remain in the project source folder. */
  readonly files: "extracted-text"
  readonly images: CapabilitySupport
  readonly tools: boolean
  /** OS sandbox modes the adapter actually configures, excluding tool-denial policies. */
  readonly sandboxModes: readonly (
    "read-only" | "workspace-write" | "danger-full-access"
  )[]
  readonly approvalPolicies: readonly AiApprovalPolicy[]
  /** Native options are interpreted at request time, never synthesized from this capability. */
  readonly approvalChoices:
    "codex-decisions" | "allow-deny" | "provider-options"
  readonly structuredInput: CapabilitySupport
  readonly interactiveTypes: readonly (
    "question" | "form" | "url" | "approval"
  )[]
}

/** Features shared by the current process adapters; individual providers refine native protocol support below. */
const common = {
  streaming: true,
  resumableSessions: true,
  structuredOutput: false,
  approvals: true,
  workspaceWrites: true,
  sessionModelSwitch: false,
  promptlessTurnContinuation: false,
  conversationRollback: false,
  files: "extracted-text",
  tools: true,
} as const

/** Audited transport support. ACP image/input support is conditional on the live peer and extension. */
export const CHAT_PROVIDER_CAPABILITIES: Readonly<
  Record<AiProviderId, ChatProviderCapabilities>
> = {
  codex: {
    ...common,
    webSearch: true,
    images: "supported",
    sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
    approvalPolicies: AI_PROVIDER_APPROVAL_POLICIES.codex,
    approvalChoices: "codex-decisions",
    structuredInput: "supported",
    interactiveTypes: ["question", "form", "url", "approval"],
  },
  "claude-code": {
    ...common,
    webSearch: false,
    images: "supported",
    sandboxModes: [],
    approvalPolicies: AI_PROVIDER_APPROVAL_POLICIES["claude-code"],
    approvalChoices: "allow-deny",
    structuredInput: "supported",
    interactiveTypes: ["question", "approval"],
  },
  opencode: {
    ...common,
    webSearch: false,
    images: "negotiated",
    sandboxModes: [],
    approvalPolicies: AI_PROVIDER_APPROVAL_POLICIES.opencode,
    approvalChoices: "provider-options",
    structuredInput: "unsupported",
    interactiveTypes: ["approval"],
  },
}

/** Returns current adapter support plus valid reasoning values for a specific model; unknown models use existing conservative defaults. */
export function getChatModelCapabilities(
  provider: AiProviderId,
  model: string
) {
  const reasoningEfforts = getSupportedAiReasoningEffortsForProvider(
    provider,
    model
  )
  return {
    ...CHAT_PROVIDER_CAPABILITIES[provider],
    reasoningEfforts,
    reasoningEffort: reasoningEfforts.some((effort) => effort !== "default"),
  }
}

/** Visible access descriptions match enforced adapter behavior, without implying automatic review or an OS sandbox. */
export function providerAccessChoice(
  provider: AiProviderId,
  policy: AiApprovalPolicy
): { label: string; description: string } {
  const choices: Record<
    AiProviderId,
    Partial<Record<AiApprovalPolicy, { label: string; description: string }>>
  > = {
    codex: {
      "on-request": {
        label: "Ask for approval",
        description:
          "The model can request approval for more access. Filesystem access follows the chat sandbox settings.",
      },
      untrusted: {
        label: "Ask for untrusted commands",
        description:
          "Commands outside the trusted set require your approval. Filesystem access follows the chat sandbox settings.",
      },
      never: {
        label: "Never approve",
        description: "Requests for more access are denied. Filesystem access follows the chat sandbox settings.",
      },
      "full-access": {
        label: "Full access",
        description:
          "No OS sandbox. Commands and network access do not require approval.",
      },
    },
    "claude-code": {
      never: {
        label: "Tools disabled",
        description: "Tools are unavailable. No OS sandbox is configured.",
      },
      "on-request": {
        label: "Ask permissions",
        description:
          "Available tools require permission. No OS sandbox is configured.",
      },
      "full-access": {
        label: "Bypass permissions",
        description:
          "Available tools run without approval. No OS sandbox is configured.",
      },
    },
    opencode: {
      never: {
        label: "Deny tools",
        description: "Tool requests are denied. No OS sandbox is configured.",
      },
      "on-request": {
        label: "Ask",
        description:
          "Tool requests require permission. No OS sandbox is configured.",
      },
      "full-access": {
        label: "Allow",
        description:
          "Available tools run without approval. No OS sandbox is configured.",
      },
    },
  }
  return (
    choices[provider][policy] ?? {
      label: "Unavailable",
      description: "This access policy is not supported by this provider.",
    }
  )
}
