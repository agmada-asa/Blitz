/**
 * Validators for a Teach session's lesson outline and section plan, shared by
 * the schema and the mutation that records Teach progress. The shapes mirror
 * `TeachOutline` and `TeachSectionPlan` in `lib/teach.ts`.
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
