/**
 * Spending limits for background tasks on an API-key sign-in.
 *
 * A subscription has its own usage limits, but an API key bills every token,
 * so a runaway mock exam, question bank, or podcast section could cost real
 * money. When Claude Code is signed in with an API key, each background turn
 * (never a chat or Teach turn) runs with a dollar cap and a cap on model round
 * trips, which Claude Code enforces itself. Codex and OpenCode have no such
 * control, and a subscription is never capped.
 *
 * Shared by the settings screen, the Convex record in `convex/settings.ts`,
 * and the server in `lib/server/spending-limits.ts`.
 */

/** The two caps applied to one background turn. */
export type SpendingLimits = {
  /** Most one background turn may spend, in US dollars, as Claude Code prices it. */
  maxTaskUsd: number
  /** Most model round trips one background turn may take. */
  maxTaskSteps: number
}

/**
 * Defaults when nothing is saved. A large mock exam prompt is about 55,000
 * input tokens with up to about 40,000 output tokens, thinking included:
 * roughly $1 on Claude Opus 5.5 ($4 / $20 per million tokens) and $2.60 on
 * Claude Fable 5.1 ($10 / $50), from Anthropic's model pricing table
 * (2026-10). $3 lets any normal run finish and stops one that keeps going.
 * Background turns have no tools except the structured reply, so a normal
 * run takes one or two round trips and a schema retry a few more; 10 steps
 * leaves room for those and stops a loop.
 */
export const DEFAULT_SPENDING_LIMITS: SpendingLimits = {
  maxTaskUsd: 3,
  maxTaskSteps: 10,
}

/** Accepted range for `maxTaskUsd`, in US dollars. */
export const TASK_USD_RANGE = { min: 0.1, max: 50 } as const

/**
 * Accepted range for `maxTaskSteps`. Two is the floor because a structured
 * reply takes a round trip of its own.
 */
export const TASK_STEPS_RANGE = { min: 2, max: 50 } as const

/**
 * Checks limits entered in Settings or read back from storage.
 * @returns The limits, with dollars rounded to cents.
 * @throws With learner-facing copy when a value is missing or out of range.
 */
export function validateSpendingLimits(value: {
  maxTaskUsd: unknown
  maxTaskSteps: unknown
}): SpendingLimits {
  const usd = typeof value.maxTaskUsd === "number" ? value.maxTaskUsd : NaN
  const steps =
    typeof value.maxTaskSteps === "number" ? value.maxTaskSteps : NaN
  if (
    !Number.isFinite(usd) ||
    usd < TASK_USD_RANGE.min ||
    usd > TASK_USD_RANGE.max
  )
    throw new Error(
      `Set a task limit between $${TASK_USD_RANGE.min.toFixed(2)} and $${TASK_USD_RANGE.max.toFixed(2)}.`
    )
  if (
    !Number.isInteger(steps) ||
    steps < TASK_STEPS_RANGE.min ||
    steps > TASK_STEPS_RANGE.max
  )
    throw new Error(
      `Set a step limit between ${TASK_STEPS_RANGE.min} and ${TASK_STEPS_RANGE.max}.`
    )
  return { maxTaskUsd: Math.round(usd * 100) / 100, maxTaskSteps: steps }
}

/**
 * Formats a dollar limit for copy, such as "$3.00".
 * @param usd Amount in US dollars.
 */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}
