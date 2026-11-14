/** Applies OpenCode v2 native tool rules in a dedicated agent without changing user settings. */
import type { ProviderTextTurnRequest } from "./types.ts"

/** The access settings of one turn that decide OpenCode's native permissions. */
export type OpenCodePolicyRequest = Pick<
  ProviderTextTurnRequest,
  "ephemeral" | "webSearchMode" | "approvalPolicy" | "sandbox"
>

/**
 * Built-in OpenCode tools that only read or search, allowed in read-only and
 * no-approval chat turns. Editing, shell, and MCP tools still need approval
 * there, which those turns cannot grant.
 */
const READ_ONLY_TOOLS = [
  "read",
  "glob",
  "grep",
  "list",
  "skill",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
] as const

/**
 * Builds the per-process environment for one OpenCode turn.
 *
 * Background generation runs with every tool denied. Chat turns keep the
 * user's global OpenCode setup, including plugins and MCP servers, and map
 * Blitz's access policy onto native permissions: full access allows
 * everything, on-request asks through Blitz, and never/read-only allow only
 * read tools. Project config stays disabled in every turn, because Blitz
 * workspaces are directories the agent itself can write to.
 *
 * `opencode acp` reads `OPENCODE_CONFIG_CONTENT` in its own process, so the
 * rules reach only this turn. They are set both globally and on the Blitz
 * agent, so a session that switches agent keeps them. OpenCode v2 has no pure
 * mode, so background turns load the user's own plugins too; with every tool
 * denied, those plugins have nothing to act on.
 *
 * @param request - Normalized provider turn.
 * @param agentName - Dedicated Blitz agent that carries the permissions.
 * @returns Environment variables for the spawned OpenCode process.
 */
export function openCodeEnvironment(
  request: OpenCodePolicyRequest,
  agentName: string
): NodeJS.ProcessEnv {
  // Background generation reads untrusted source text and needs no tools.
  const background =
    request.ephemeral ||
    request.webSearchMode === "disabled" ||
    !request.approvalPolicy
  const readOnly =
    request.sandbox === "read-only" || request.approvalPolicy === "never"
  const action = background || readOnly
    ? "deny"
    : request.approvalPolicy === "full-access"
      ? "allow"
      : "ask"
  const permission = {
    "*": action,
    ...(!background && readOnly
      ? {
          ...Object.fromEntries(READ_ONLY_TOOLS.map((tool) => [tool, "allow"])),
          // OpenCode asks before reading env files; these turns cannot ask.
          read: {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
            "*.env.example": "allow",
          },
        }
      : {}),
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
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission,
      default_agent: agentName,
      agent: { [agentName]: { mode: "primary", permission } },
    }),
  }
}
