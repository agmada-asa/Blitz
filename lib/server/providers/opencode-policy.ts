/** Applies OpenCode v1 native tool rules in a dedicated agent without changing user settings. */
import type { ProviderTextTurnRequest } from "./types.ts"

/** Builds per-process rules. Background turns disable all tools; interactive grants remain single-use. */
export function openCodeEnvironment(
  request: ProviderTextTurnRequest,
  agentName: string
): NodeJS.ProcessEnv {
  const action =
    request.sandbox === "read-only" ||
    request.ephemeral ||
    request.webSearchMode === "disabled" ||
    request.approvalPolicy === "never" ||
    !request.approvalPolicy
      ? "deny"
      : request.approvalPolicy === "full-access"
        ? "allow"
        : "ask"
  const permission = {
    "*": action,
    task: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    question: "deny",
  }
  const env = { ...process.env }
  // Project configuration can install tools or change agents before a permission request.
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_DIR
  return {
    ...env,
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      default_agent: agentName,
      agent: { [agentName]: { mode: "primary", permission } },
    }),
  }
}
