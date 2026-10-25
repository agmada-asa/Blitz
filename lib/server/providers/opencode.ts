/**
 * Runs OpenCode through agent-engines' ACP engine, so OpenCode turns share the
 * Codex and Claude Code event path in `engine-turn.ts`.
 *
 * The library owns the ACP protocol: the agent process, sessions, streaming,
 * permission and elicitation requests, and cleanup. Blitz keeps what is its
 * own policy: the per-turn OpenCode environment from `opencode-policy.ts`
 * (native permissions and a dedicated Blitz agent), how Blitz's access setting
 * maps onto the engine's access levels, and how application instructions
 * reach an agent that has no instruction channel.
 */

import {
  ACP_AGENTS,
  AcpEngine,
  type AcpEngineOptions,
  type ThreadOptions,
} from "agent-engines"

import { CardChatError } from "../card-chat.ts"
import { openCodeEnvironment, type OpenCodePolicyRequest } from "./opencode-policy.ts"
import { providerCommand } from "./registry.ts"

/**
 * Name of the OpenCode agent that carries each turn's permissions.
 *
 * OpenCode remembers the agent a session last used and refuses to prompt a
 * reloaded session whose agent no longer exists, so the name is the same on
 * every turn: each turn redefines the agent with that turn's permissions.
 * Sessions saved under the per-turn names Blitz used before fail to resume,
 * and the chat replays their history into a new session instead.
 */
export const OPENCODE_AGENT_NAME = "blitz-turn"

/** Longest application instructions sent ahead of an OpenCode prompt. */
export const MAX_OPENCODE_INSTRUCTIONS_LENGTH = 16_000

/** Process seam for tests; omitted, the configured `opencode` CLI is started. */
export type OpenCodeSpawn = AcpEngineOptions["spawnProcess"]

/**
 * Creates the ACP engine for one OpenCode turn, which the caller closes.
 *
 * The environment carries the turn's permission policy, so an engine serves
 * exactly one turn. The agent process starts in the workspace, as Blitz's own
 * adapter did, and only when the engine is first used.
 *
 * @param policy - The turn's access settings, which decide its permissions.
 * @param workspaceDirectory - Absolute folder the agent works in.
 * @param spawnProcess - Optional fake process for tests.
 */
export function createOpenCodeEngine(
  policy: OpenCodePolicyRequest,
  workspaceDirectory: string,
  spawnProcess?: OpenCodeSpawn
): AcpEngine {
  const command = providerCommand("opencode")
  return new AcpEngine({
    name: ACP_AGENTS.opencode.name,
    command: command.executable,
    args: command.args,
    cwd: workspaceDirectory,
    env: openCodeEnvironment(policy, OPENCODE_AGENT_NAME),
    clientName: "blitz",
    ...(spawnProcess ? { spawnProcess } : {}),
  })
}

/**
 * Maps Blitz's access settings onto the engine's access level, which answers
 * the permission requests OpenCode still sends after its native rules.
 *
 * Full access allows each request once. Background turns, read-only turns and
 * turns with approvals off refuse; their native rules already deny everything
 * but reading. Approval turns ask, and the chat answers through its composer.
 */
export function openCodeAccess(
  policy: OpenCodePolicyRequest
): NonNullable<ThreadOptions["access"]> {
  const background =
    policy.ephemeral ||
    policy.webSearchMode === "disabled" ||
    !policy.approvalPolicy
  if (background) return "read-only"
  if (policy.approvalPolicy === "full-access") return "full"
  if (policy.sandbox === "read-only" || policy.approvalPolicy === "never")
    return "read-only"
  return "ask"
}

/**
 * Puts Blitz's application instructions ahead of the learner's prompt.
 *
 * ACP has no instruction channel, so the instructions travel in a tagged block
 * the model can tell apart from the learner's own words.
 *
 * @throws CardChatError (`invalid-input`) when the instructions are over
 *   {@link MAX_OPENCODE_INSTRUCTIONS_LENGTH} characters.
 */
export function openCodePrompt(prompt: string, instructions: string): string {
  const context = instructions.trim()
  if (context.length > MAX_OPENCODE_INSTRUCTIONS_LENGTH)
    throw new CardChatError(
      "invalid-input",
      `Provider application instructions exceed the ${MAX_OPENCODE_INSTRUCTIONS_LENGTH.toLocaleString("en-GB")} character limit`
    )
  return context
    ? `<blitz_application_context>\n${context}\n</blitz_application_context>\n\n${prompt}`
    : prompt
}
