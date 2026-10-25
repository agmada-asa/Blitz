/**
 * The provider settings every Teach turn runs with, in one place, and the
 * reply selection a new chat starts on.
 *
 * Teach reads untrusted course files, so its turns never inherit the chat
 * access setting: a read-only sandbox, no approvals to wait on, and the
 * project folder's instructions with no extra ones. The chat route, the
 * prewarm route, and Compact now all use this, so a prewarmed Claude Code
 * thread matches the first turn exactly and a compaction resumes the thread
 * with the settings its turns use.
 */

import type { AiProviderId } from "../ai-model-settings.ts"
import { resolveAiTaskSelection } from "../ai-model-settings.ts"
import { projectAgentInstructions } from "./project-agent.ts"
import type { RunProviderTextTurnRequest } from "./providers/run-text-turn.ts"

/**
 * Returns the sandbox, approval policy, and instructions for a Teach turn.
 *
 * @param providerId - The session's provider.
 * @param workspaceDirectory - The unit's project folder.
 */
export function teachTurnSettings(
  providerId: AiProviderId,
  workspaceDirectory: string
): Pick<
  RunProviderTextTurnRequest,
  "sandbox" | "approvalPolicy" | "developerInstructions"
> {
  return {
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions: projectAgentInstructions(
      workspaceDirectory,
      "",
      providerId === "codex"
    ),
  }
}

/**
 * The reply provider, model, and effort a chat or Teach turn uses when its
 * chat has none saved yet, with the server's environment fallbacks.
 *
 * @param settings - Saved model settings.
 */
export function chatReplySelection(
  settings: Parameters<typeof resolveAiTaskSelection>[0]
): ReturnType<typeof resolveAiTaskSelection> {
  return resolveAiTaskSelection(settings, "reply", {
    providerEnvironmentFallback: process.env.BLITZ_REPLY_PROVIDER,
    modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
    effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
  })
}
