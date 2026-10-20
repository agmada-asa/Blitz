/**
 * Validator for the FSRS memory stored on each concept review, shared by the
 * schema and the functions that write it. The shape mirrors `ReviewMemory`
 * in `lib/learning/fsrs.ts`.
 */

import { v } from "convex/values"

/** FSRS memory of one concept after its latest scored answer. */
export const reviewMemoryFields = v.object({
  stability: v.number(),
  difficulty: v.number(),
  phase: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
  reps: v.number(),
  lapses: v.number(),
  learningSteps: v.number(),
  scheduledDays: v.number(),
  lastReviewAt: v.number(),
})
