/** Stores global task-specific Codex model and reasoning choices for Blitz's local workers. */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

import {
  DEFAULT_AI_REASONING_EFFORTS,
  validateAiModelSettings,
  type AiModelSettings,
} from "../lib/ai-model-settings"

/** Identifies the one application-wide settings record in this personal deployment. */
const GLOBAL_SETTINGS_SCOPE = "global"

/** Reads saved AI choices, or null while the app still uses its established defaults. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<AiModelSettings | null> => {
    const settings = await ctx.db
      .query("aiModelSettings")
      .withIndex("by_scope", (index) =>
        index.eq("scope", GLOBAL_SETTINGS_SCOPE)
      )
      .unique()
    if (!settings) return null
    return validateAiModelSettings({
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
    })
  },
})

/** Validates and saves all AI choices together so workers never observe a partial configuration. */
export const save = mutation({
  args: {
    researchModel: v.string(),
    replyModel: v.string(),
    cardGenerationModel: v.string(),
    researchEffort: v.string(),
    replyEffort: v.string(),
    cardGenerationEffort: v.string(),
  },
  handler: async (ctx, args): Promise<AiModelSettings> => {
    const settings = validateAiModelSettings(args)
    const existing = await ctx.db
      .query("aiModelSettings")
      .withIndex("by_scope", (index) =>
        index.eq("scope", GLOBAL_SETTINGS_SCOPE)
      )
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { ...settings, updatedAt: now })
    } else {
      await ctx.db.insert("aiModelSettings", {
        scope: GLOBAL_SETTINGS_SCOPE,
        ...settings,
        updatedAt: now,
      })
    }
    return settings
  },
})
