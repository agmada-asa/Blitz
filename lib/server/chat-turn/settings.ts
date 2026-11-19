/**
 * How a workspace chat turn runs: the agent's access and instructions, the
 * provider's approval policy and sandbox, and the model and wording a spoken
 * turn uses. Teach sessions always run read-only with no approvals.
 */

import type { Id } from "../../../convex/_generated/dataModel.js"
import {
  resolveProviderApprovalPolicy,
  type AiApprovalPolicy,
  type AiModelSettings,
  type AiProviderId,
} from "../../ai-model-settings.ts"
import type { ProjectAgentAutonomy } from "../project-agent.ts"
import { getCodexModelCatalog } from "../providers/codex-models.ts"
import type { RunProviderTextTurnRequest } from "../providers/run-text-turn.ts"
import type { WorkspaceChatRequest } from "../workspace-chat.ts"

/** Agent settings saved on a chat. */
export type SavedAgentSettings = {
  autonomy: ProjectAgentAutonomy
  additionalInstructions: string
  workingProjectId?: Id<"projects">
  planFirst: boolean
}

/**
 * The agent settings one turn runs with: the composer's choices when it sent
 * any, else the chat's saved ones. Agent controls from ordinary chats never
 * apply to Teach sessions, and Plan first applies only to project agents.
 *
 * @param input - The turn's request.
 * @param saved - The chat's saved agent settings.
 * @param teach - Whether the chat is a Teach session.
 */
export function turnAgentSettings(
  input: WorkspaceChatRequest,
  saved: SavedAgentSettings,
  teach: boolean
): {
  autonomy: ProjectAgentAutonomy
  additionalInstructions: string
  workingProjectId: Id<"projects"> | undefined
  planFirst: boolean
} {
  const workingProjectId = teach
    ? undefined
    : input.autonomy === undefined
      ? saved.workingProjectId
      : input.workingProjectId
  return {
    autonomy: teach ? "approval" : (input.autonomy ?? saved.autonomy),
    additionalInstructions: teach
      ? ""
      : (input.additionalInstructions ?? saved.additionalInstructions),
    workingProjectId,
    planFirst:
      !teach &&
      Boolean(workingProjectId) &&
      (input.planFirst ?? saved.planFirst),
  }
}

/**
 * Moves a spoken turn to the selected provider's fast option, so a voice
 * reply needs no other account. `BLITZ_VOICE_MODEL` overrides the choice.
 *
 * @param selection - The turn's provider selection; updated in place.
 */
export async function applySpokenModel(selection: {
  providerId: AiProviderId
  model: string
  effort?: string
}): Promise<void> {
  if (selection.providerId === "claude-code") {
    selection.model = process.env.BLITZ_VOICE_MODEL || "haiku"
    selection.effort = undefined
  } else if (selection.providerId === "codex") {
    const models = await getCodexModelCatalog()
    const fast =
      models.find((model) => model.id === process.env.BLITZ_VOICE_MODEL) ??
      models.find((model) => /mini|spark/i.test(model.id))
    if (fast) {
      selection.model = fast.id
      selection.effort = fast.reasoningEfforts?.includes("low")
        ? "low"
        : undefined
    }
  } else if (process.env.BLITZ_VOICE_MODEL) {
    selection.model = process.env.BLITZ_VOICE_MODEL
    selection.effort = undefined
  }
}

/**
 * The approval policy a turn runs with. Teach reads untrusted course files,
 * so it never inherits the global access setting: it has no approvals to
 * wait on. Approval mode uses the provider's saved policy.
 */
export function turnApprovalPolicy(
  teach: boolean,
  autonomy: ProjectAgentAutonomy,
  settings: AiModelSettings | null,
  providerId: AiProviderId
): AiApprovalPolicy {
  if (teach) return "never"
  if (autonomy === "approval")
    return resolveProviderApprovalPolicy(settings, providerId)
  return autonomy === "full" ? "full-access" : "never"
}

/**
 * The sandbox a turn asks for. Teach is always read-only; other turns set one
 * only on Codex, matched to the agent's access.
 */
export function turnSandbox(
  teach: boolean,
  providerId: AiProviderId,
  approvalPolicy: AiApprovalPolicy,
  autonomy: ProjectAgentAutonomy
): RunProviderTextTurnRequest["sandbox"] {
  if (teach) return "read-only"
  if (providerId !== "codex") return undefined
  if (approvalPolicy === "full-access" || autonomy === "full")
    return "danger-full-access"
  return autonomy === "project" ? "workspace-write" : "read-only"
}

/**
 * Adds the spoken-conversation guidance to a prompt: short sentences and
 * maths in words, and for ordinary chats no Markdown. Teach keeps its lesson
 * Markdown for the screen.
 *
 * @param prompt - The turn's prompt.
 * @param teach - Whether the chat is a Teach session.
 * @param voiceNote - What happened to the last spoken reply, when known.
 */
export function spokenPrompt(
  prompt: string,
  teach: boolean,
  voiceNote: string | undefined
): string {
  return (
    prompt +
    "\n\nThis is a spoken conversation. Recognition may contain small errors. Use short sentences and say maths in words. " +
    (teach
      ? "Keep lesson Markdown for the screen."
      : "Lead with the answer. Avoid Markdown, tables, code and links. Keep replies brief unless asked for detail.") +
    (voiceNote ? `\n\n${voiceNote}` : "")
  )
}
