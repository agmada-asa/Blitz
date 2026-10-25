/**
 * Decides the spending caps for one background Claude Code turn.
 *
 * Caps apply only when Claude Code is signed in with an API key, which bills
 * per token; a subscription is never capped. The sign-in is read from the
 * runtime itself (no model call) and remembered for a few minutes, so a
 * podcast's many section turns do not each start a probe. The caps are the
 * ones saved in Settings, or the defaults in `lib/spending-limits.ts`.
 */

import type { TurnLimits } from "agent-engines"

import { api } from "../../convex/_generated/api.js"
import {
  DEFAULT_SPENDING_LIMITS,
  validateSpendingLimits,
  type SpendingLimits,
} from "../spending-limits.ts"
import { serverConvexClient } from "./convex.ts"
import { createClaudeEngine } from "./providers/engines.ts"

/** How long one sign-in check is trusted before Claude Code is asked again. */
const BILLING_CACHE_MS = 5 * 60_000

/** How the Claude Code sign-in is billed, as far as the runtime says. */
export type ClaudeBilling = "api-key" | "subscription" | "unknown"

/** The last sign-in check, shared by every turn in this server process. */
let cachedBilling: { value: Promise<ClaudeBilling>; at: number } | undefined

/**
 * Asks Claude Code how it is signed in. A failed check is `unknown`, which
 * still gets caps: an unreadable sign-in should not mean unlimited spend.
 */
async function probeClaudeBilling(): Promise<ClaudeBilling> {
  const engine = createClaudeEngine()
  try {
    const state = await engine.availability()
    if (state.account?.kind === "api-key") return "api-key"
    if (state.account?.kind === "subscription") return "subscription"
    return "unknown"
  } catch {
    return "unknown"
  } finally {
    await engine.close().catch(() => undefined)
  }
}

/**
 * Returns how Claude Code is billed, from a check at most five minutes old.
 * @param now Clock for tests.
 */
export function claudeBilling(now = Date.now()): Promise<ClaudeBilling> {
  if (!cachedBilling || now - cachedBilling.at > BILLING_CACHE_MS)
    cachedBilling = { value: probeClaudeBilling(), at: now }
  return cachedBilling.value
}

/** Forgets the cached sign-in check, after a sign-in change or in tests. */
export function forgetClaudeBilling(): void {
  cachedBilling = undefined
}

/** Reads the saved caps, falling back to the defaults when Convex has none or is unreachable. */
export async function savedSpendingLimits(): Promise<SpendingLimits> {
  const client = serverConvexClient()
  if (!client) return DEFAULT_SPENDING_LIMITS
  try {
    return validateSpendingLimits(
      await client.query(api.settings.spendingLimits)
    )
  } catch {
    return DEFAULT_SPENDING_LIMITS
  }
}

/**
 * Converts saved caps into the runtime's turn limits.
 * @param limits Caps from Settings.
 */
export function turnLimits(limits: SpendingLimits): TurnLimits {
  return { maxBudgetUsd: limits.maxTaskUsd, maxTurns: limits.maxTaskSteps }
}

/**
 * Returns the limits for one background Claude Code turn, or undefined when
 * the sign-in is a subscription. Never throws.
 * @param billing Sign-in check; tests pass a fixed one.
 * @param limits Saved caps; tests pass fixed ones.
 */
export async function claudeBackgroundLimits(
  billing: () => Promise<ClaudeBilling> = claudeBilling,
  limits: () => Promise<SpendingLimits> = savedSpendingLimits
): Promise<TurnLimits | undefined> {
  if ((await billing().catch(() => "unknown" as const)) === "subscription")
    return undefined
  return turnLimits(await limits().catch(() => DEFAULT_SPENDING_LIMITS))
}
