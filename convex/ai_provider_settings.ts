/** Resolves immutable provider selections for Convex-owned queue records. */

import type { QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import {
  DEFAULT_AI_REASONING_EFFORTS,
  resolveAiTaskSelection,
  validateAiModelSettings,
  type AiTask,
} from "../lib/ai-model-settings"

/** The single settings scope used by this personal deployment. */
const GLOBAL_SETTINGS_SCOPE = "global"

/** Converts a saved document into the validated settings shape used by routing. */
function savedSettingsInput(
  settings: Doc<"aiModelSettings"> | null
): Parameters<typeof validateAiModelSettings>[0] | null {
  if (!settings) return null
  return {
    providerApprovalPolicies: settings.providerApprovalPolicies,
    researchProvider: settings.researchProvider,
    replyProvider: settings.replyProvider,
    cardGenerationProvider: settings.cardGenerationProvider,
    researchModel: settings.researchModel,
    replyModel: settings.replyModel,
    cardGenerationModel: settings.cardGenerationModel,
    researchEffort:
      settings.researchEffort ?? DEFAULT_AI_REASONING_EFFORTS.researchEffort,
    replyEffort:
      settings.replyEffort ?? DEFAULT_AI_REASONING_EFFORTS.replyEffort,
    cardGenerationEffort:
      settings.cardGenerationEffort ??
      DEFAULT_AI_REASONING_EFFORTS.cardGenerationEffort,
  }
}

/** Reads saved settings without allowing a malformed legacy row to block a queue. */
async function loadValidatedSettings(
  ctx: Pick<QueryCtx, "db">
): Promise<ReturnType<typeof validateAiModelSettings> | null> {
  try {
    const saved = await ctx.db
      .query("aiModelSettings")
      .withIndex("by_scope", (index) =>
        index.eq("scope", GLOBAL_SETTINGS_SCOPE)
      )
      .unique()
    const input = savedSettingsInput(saved)
    if (!input) return null
    return validateAiModelSettings(input)
  } catch {
    return null
  }
}

/** Resolves the provider, model, and reasoning snapshot for one queued task. */
export async function resolveQueuedAiSelection(
  ctx: Pick<QueryCtx, "db">,
  task: AiTask
): Promise<ReturnType<typeof resolveAiTaskSelection>> {
  const settings = await loadValidatedSettings(ctx)
  return resolveAiTaskSelection(settings, task)
}
