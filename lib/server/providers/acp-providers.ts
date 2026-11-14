/**
 * What Blitz's two ACP providers, OpenCode and Antigravity, share: which
 * providers they are, the engine for one turn, how Blitz's access setting maps
 * onto the engine's access levels, and how application instructions reach an
 * agent that has no instruction channel.
 *
 * Each provider's own launch policy is in `opencode.ts` and `antigravity.ts`.
 */

import type { AcpEngine, AcpEngineOptions, ThreadOptions } from "agent-engines"

import type { AiProviderId } from "../../ai-model-settings.ts"
import { CardChatError } from "../card-chat.ts"
import { createAntigravityEngine } from "./antigravity.ts"
import { createOpenCodeEngine } from "./opencode.ts"
import type { ProviderTextTurnRequest } from "./types.ts"

/** Blitz providers that run on agent-engines' ACP engine. */
export const ACP_PROVIDER_IDS = ["opencode", "antigravity"] as const

/** One Blitz provider that runs on agent-engines' ACP engine. */
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number]

/** Longest application instructions sent ahead of an ACP prompt. */
export const MAX_ACP_INSTRUCTIONS_LENGTH = 16_000

/** Process seam for tests; omitted, the provider's configured CLI is started. */
export type AcpSpawn = AcpEngineOptions["spawnProcess"]

/** The access settings of one turn that decide an ACP agent's permissions. */
export type AcpPolicyRequest = Pick<
  ProviderTextTurnRequest,
  "ephemeral" | "webSearchMode" | "approvalPolicy" | "sandbox"
>

/** Display names used in setup and error messages. */
export const ACP_PROVIDER_NAMES: Readonly<Record<AcpProviderId, string>> = {
  opencode: "OpenCode",
  antigravity: "Antigravity",
}

/** Returns whether a provider runs on the ACP engine. */
export function isAcpProvider(
  providerId: AiProviderId | string | null | undefined
): providerId is AcpProviderId {
  return ACP_PROVIDER_IDS.includes(providerId as AcpProviderId)
}

/**
 * Creates the ACP engine for one turn of an ACP provider, which the caller
 * closes. The engine carries that turn's launch policy, so it serves one turn.
 *
 * @param providerId - OpenCode or Antigravity.
 * @param policy - The turn's access settings.
 * @param workspaceDirectory - Absolute folder the agent works in.
 * @param spawnProcess - Optional fake process for tests.
 */
export function createAcpProviderEngine(
  providerId: AcpProviderId,
  policy: AcpPolicyRequest,
  workspaceDirectory: string,
  spawnProcess?: AcpSpawn
): AcpEngine {
  return providerId === "opencode"
    ? createOpenCodeEngine(policy, workspaceDirectory, spawnProcess)
    : createAntigravityEngine(policy, workspaceDirectory, spawnProcess)
}

/**
 * Maps Blitz's access settings onto the engine's access level, which answers
 * the permission requests an ACP agent sends.
 *
 * Full access allows each request once. Background turns, read-only turns and
 * turns with approvals off refuse; OpenCode's native rules already deny
 * everything but reading there. Approval turns ask, and the chat answers
 * through its composer.
 */
export function acpAccess(
  policy: AcpPolicyRequest
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
 *   {@link MAX_ACP_INSTRUCTIONS_LENGTH} characters.
 */
export function acpPrompt(prompt: string, instructions: string): string {
  const context = instructions.trim()
  if (context.length > MAX_ACP_INSTRUCTIONS_LENGTH)
    throw new CardChatError(
      "invalid-input",
      `Provider application instructions exceed the ${MAX_ACP_INSTRUCTIONS_LENGTH.toLocaleString("en-GB")} character limit`
    )
  return context
    ? `<blitz_application_context>\n${context}\n</blitz_application_context>\n\n${prompt}`
    : prompt
}
