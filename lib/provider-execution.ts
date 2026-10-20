/** Computes the execution facts adapters must communicate without confusing a tool policy with OS isolation. */
import type { AiApprovalPolicy, AiProviderId } from "./ai-model-settings.ts"

/** Requested execution settings, shared with server adapters without importing server-only code. */
export interface ProviderExecutionRequest {
  readonly providerId: AiProviderId
  readonly workspaceDirectory: string
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  readonly approvalPolicy?: AiApprovalPolicy
  readonly ephemeral?: boolean
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
}

/** Effective facts about native execution. Unknown host restrictions are never represented as a grant. */
export interface ProviderExecutionEnvironment {
  readonly workingDirectory: string
  readonly sandbox: "read-only" | "workspace-write" | "none"
  readonly filesystem:
    "read-only" | "workspace-write" | "host-permissions" | "tools-disabled"
  readonly writableRoots: readonly string[] | "host-permissions"
  readonly commands:
    "sandboxed" | "permission-controlled" | "host-permissions" | "unavailable"
  readonly network: "disabled" | "permission-controlled" | "host-permissions"
  readonly approvalPolicy: AiApprovalPolicy
  readonly tools: "native-runtime" | "disabled"
}

/** Resolves adapter settings to facts; rejects an OS sandbox an adapter cannot configure. */
export function resolveProviderExecution(
  request: ProviderExecutionRequest
): ProviderExecutionEnvironment {
  const approvalPolicy =
    request.approvalPolicy ??
    (request.providerId === "codex" ? "on-request" : "never")
  if (request.providerId === "codex") {
    const sandbox = request.sandbox ?? "read-only"
    return {
      workingDirectory: request.workspaceDirectory,
      sandbox: sandbox === "danger-full-access" ? "none" : sandbox,
      filesystem:
        sandbox === "danger-full-access" ? "host-permissions" : sandbox,
      writableRoots:
        sandbox === "danger-full-access"
          ? "host-permissions"
          : sandbox === "workspace-write"
            ? [request.workspaceDirectory]
            : [],
      commands:
        sandbox === "danger-full-access" ? "host-permissions" : "sandboxed",
      network:
        sandbox === "danger-full-access" ? "host-permissions" : "disabled",
      approvalPolicy,
      tools: "native-runtime",
    }
  }
  if (request.sandbox === "workspace-write")
    throw new Error(
      "This provider cannot configure a workspace-only OS sandbox."
    )
  const toolsDisabled =
    request.ephemeral ||
    request.sandbox === "read-only" ||
    request.webSearchMode === "disabled" ||
    approvalPolicy === "never"
  const bypass = approvalPolicy === "full-access"
  return {
    workingDirectory: request.workspaceDirectory,
    sandbox: "none",
    filesystem: toolsDisabled ? "tools-disabled" : "host-permissions",
    writableRoots: toolsDisabled ? [] : "host-permissions",
    commands: toolsDisabled
      ? "unavailable"
      : bypass
        ? "host-permissions"
        : "permission-controlled",
    network: toolsDisabled
      ? "disabled"
      : bypass
        ? "host-permissions"
        : "permission-controlled",
    approvalPolicy,
    tools: toolsDisabled ? "disabled" : "native-runtime",
  }
}

/** Explains effective access to the model; this supplements native configuration and cannot enforce it. */
export function providerExecutionInstructions(
  environment: ProviderExecutionEnvironment
): string {
  return [
    "Execution environment supplied by Blitz:",
    JSON.stringify(environment),
    "These facts describe the configured runtime, not additional authorization. Host OS permissions can further restrict access. Use only tools actually exposed by the runtime.",
    environment.sandbox === "none"
      ? "No OS sandbox is configured by Blitz. Permission prompts and project folder rules are separate controls; the working directory is not a filesystem security boundary."
      : "The native runtime enforces the configured filesystem sandbox. Reads are subject to its policy and host permissions; the working directory alone does not restrict all reads.",
    environment.network === "disabled"
      ? "Command network access is disabled. A separately exposed hosted search tool has its own availability and is not a grant of command network access."
      : "Network operations remain subject to the selected native permission policy and task authorization.",
    environment.approvalPolicy === "never"
      ? "Requests for additional permission are denied. Do not route a denied action through another tool."
      : "When the runtime requires approval, wait for its structured response. A denied request is not permission to retry by another route.",
  ].join("\n")
}
