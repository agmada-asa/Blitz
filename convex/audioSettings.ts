/** Reads and saves the ordered Kokoro voices selected as podcast hosts. */

import {
  validateKokoroVoiceIds,
  type KokoroVoiceId,
} from "../lib/kokoro-voices"
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

/** Identifies the single application-wide audio settings record. */
const GLOBAL_AUDIO_SCOPE = "global"

/** Returns saved podcast host voices, or null before the user saves a choice. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<{ voiceIds: KokoroVoiceId[] } | null> => {
    const settings = await ctx.db
      .query("audioVoiceSettings")
      .withIndex("by_scope", (index) => index.eq("scope", GLOBAL_AUDIO_SCOPE))
      .unique()
    if (!settings) return null
    return { voiceIds: validateKokoroVoiceIds(settings.voiceIds) }
  },
})

/** Validates and saves one or two ordered Kokoro podcast host voices. */
export const save = mutation({
  args: {
    voiceIds: v.array(
      v.union(
        v.literal("af_heart"),
        v.literal("af_bella"),
        v.literal("af_nicole"),
        v.literal("am_fenrir"),
        v.literal("am_puck")
      )
    ),
  },
  handler: async (ctx, args): Promise<{ voiceIds: KokoroVoiceId[] }> => {
    const voiceIds = validateKokoroVoiceIds(args.voiceIds)
    const existing = await ctx.db
      .query("audioVoiceSettings")
      .withIndex("by_scope", (index) => index.eq("scope", GLOBAL_AUDIO_SCOPE))
      .unique()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { voiceIds, updatedAt: now })
    } else {
      await ctx.db.insert("audioVoiceSettings", {
        scope: GLOBAL_AUDIO_SCOPE,
        voiceIds,
        updatedAt: now,
      })
    }
    return { voiceIds }
  },
})
