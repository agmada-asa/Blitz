/**
 * Stores the global provider, model, and reasoning choices each local worker
 * uses for its task, and the spending caps for background tasks on an
 * API-key sign-in.
 */

import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

import {
  DEFAULT_AI_REASONING_EFFORTS,
  validateAiModelSettings,
  validateAiTaskProviders,
  type AiModelSettings,
} from "../lib/ai-model-settings"
import {
  DEFAULT_SPENDING_LIMITS,
  validateSpendingLimits,
  type SpendingLimits,
} from "../lib/spending-limits"

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
    })
  },
})

/** Validates and saves all AI choices together so workers never observe a partial configuration. */
export const save = mutation({
  args: {
    providerApprovalPolicies: v.optional(v.record(v.string(), v.string())),
    researchProvider: v.optional(v.string()),
    replyProvider: v.optional(v.string()),
    cardGenerationProvider: v.optional(v.string()),
    researchModel: v.string(),
    replyModel: v.string(),
    cardGenerationModel: v.string(),
    researchEffort: v.string(),
    replyEffort: v.string(),
    cardGenerationEffort: v.string(),
  },
  handler: async (ctx, args): Promise<AiModelSettings> => {
    const settings = validateAiModelSettings(args)
    validateAiTaskProviders(settings)
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

/** Reads the saved background spending caps, or the defaults when none are saved. */
export const spendingLimits = query({
  args: {},
  handler: async (ctx): Promise<SpendingLimits & { saved: boolean }> => {
    const saved = await ctx.db
      .query("spendingLimits")
      .withIndex("by_scope", (index) => index.eq("scope", GLOBAL_SETTINGS_SCOPE))
      .unique()
    if (!saved) return { ...DEFAULT_SPENDING_LIMITS, saved: false }
    try {
      return { ...validateSpendingLimits(saved), saved: true }
    } catch {
      // A record outside today's bounds falls back to the defaults rather than no cap.
      return { ...DEFAULT_SPENDING_LIMITS, saved: false }
    }
  },
})

/** Validates and saves the background spending caps. */
export const saveSpendingLimits = mutation({
  args: { maxTaskUsd: v.number(), maxTaskSteps: v.number() },
  handler: async (ctx, args): Promise<SpendingLimits> => {
    const limits = validateSpendingLimits(args)
    const existing = await ctx.db
      .query("spendingLimits")
      .withIndex("by_scope", (index) => index.eq("scope", GLOBAL_SETTINGS_SCOPE))
      .unique()
    const now = Date.now()
    if (existing) await ctx.db.patch(existing._id, { ...limits, updatedAt: now })
    else
      await ctx.db.insert("spendingLimits", {
        scope: GLOBAL_SETTINGS_SCOPE,
        ...limits,
        updatedAt: now,
      })
    return limits
  },
})
