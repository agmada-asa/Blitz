/**
 * Validators for a Teach session's lesson outline and section plan, shared by
 * the schema and the mutation that records Teach progress. The shapes mirror
 * `TeachOutline` and `TeachSectionPlan` in `lib/teach.ts`.
 *
 * Also the records a long session keeps about its model context (usage after
 * each turn and every compaction, mirroring `lib/context-usage.ts`), the style
 * a redone Teach reply was asked for, and the runtime notices saved on any
 * chat reply (`lib/turn-notices.ts`).
 */

import { v } from "convex/values"

/** The tutor's outline: a title and sections, each with its concept names. */
export const teachOutlineFields = v.object({
  title: v.string(),
  sections: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      /** Distinct examinable ideas the section teaches; absent on older outlines. */
      concepts: v.optional(v.array(v.string())),
    })
  ),
})

/** How the tutor will treat each section after the pre-check. */
export const teachSectionPlanFields = v.array(
  v.object({
    id: v.string(),
    mode: v.union(v.literal("skip"), v.literal("skim"), v.literal("teach")),
  })
)

/** How a redone Teach reply was asked to explain the section again. */
export const teachRedoStyleField = v.union(
  v.literal("simpler"),
  v.literal("example"),
  v.literal("shorter")
)

/** How full a chat's model context was after its last turn. */
export const contextUsageFields = v.object({
  usedTokens: v.number(),
  maxTokens: v.optional(v.number()),
  /** 0 to 100, when the window is known. */
  percent: v.optional(v.number()),
  /** Used tokens by group, when the runtime breaks them down (Claude Code). */
  categories: v.optional(
    v.array(
      v.object({
        label: v.union(
          v.literal("instructions"),
          v.literal("tools"),
          v.literal("conversation"),
          v.literal("other")
        ),
        tokens: v.number(),
      })
    )
  ),
  updatedAt: v.number(),
})

/**
 * One compaction of a chat's context. `auto` ran before a turn because the
 * context passed Blitz's threshold, `overflow` after a reply ran out of room,
 * `manual` when the learner chose Compact now, and `runtime` when the runtime
 * compacted by itself mid-turn.
 */
export const contextCompactionFields = v.object({
  at: v.number(),
  origin: v.union(
    v.literal("auto"),
    v.literal("overflow"),
    v.literal("manual"),
    v.literal("runtime")
  ),
  /** Context fullness before compacting, in percent, when it was known. */
  fromPercent: v.optional(v.number()),
  /** The reply that was being written when the compaction happened. */
  messageId: v.optional(v.id("workspaceChatMessages")),
})

/** A refusal, denied tool, or safety check saved on the reply it explains. */
export const turnNoticeFields = v.object({
  kind: v.union(
    v.literal("refusal"),
    v.literal("permission-denied"),
    v.literal("moderation")
  ),
  message: v.string(),
  details: v.optional(v.string()),
})
