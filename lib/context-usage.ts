/**
 * Describes how full a chat's model context is, and when Blitz compacts it.
 *
 * After each Teach turn the server reads the runtime's context usage and saves
 * it on the chat; the Teach header shows it as a quiet meter and a sheet with
 * the breakdown. When the context passes `AUTO_COMPACT_PERCENT`, the next turn
 * compacts the thread first and restates the unit material, outline, and plan,
 * so a long unit does not run out of room late in the session. This module is
 * pure so the server, Convex, and the Teach screen share one set of rules.
 */

/** One slice of the context, grouped under a plain label. */
export type ContextUsageCategory = {
  /** `instructions`, `tools`, `conversation`, or `other`. */
  label: ContextCategoryLabel
  tokens: number
}

/** The groups a runtime's own context categories are shown under. */
export type ContextCategoryLabel = "instructions" | "tools" | "conversation" | "other"

/** How full a thread's context window was after a turn. */
export type TurnContextUsage = {
  /** Tokens in the context. */
  usedTokens: number
  /** The model's context window, when known. */
  maxTokens?: number
  /** 0 to 100, when the window is known. */
  percent?: number
  /** Where the used tokens go, when the runtime breaks it down (Claude Code). */
  categories?: ContextUsageCategory[]
}

/** Context fullness, in percent, at which Blitz compacts before the next turn. */
export const AUTO_COMPACT_PERCENT = 80

/** Most categories kept; the runtime's list is grouped down to these. */
const CATEGORY_ORDER: readonly ContextCategoryLabel[] = [
  "instructions",
  "tools",
  "conversation",
  "other",
]

/** Maps one of the runtime's category names to Blitz's group for it. */
function categoryLabel(name: string): ContextCategoryLabel {
  if (/message|conversation/i.test(name)) return "conversation"
  if (/tool/i.test(name)) return "tools"
  if (/system prompt|memory|agent|skill|instruction/i.test(name))
    return "instructions"
  return "other"
}

/** Returns a finite, non-negative whole number, or undefined. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

/**
 * Normalizes the runtime's context report into the shape Blitz saves.
 *
 * Free space and the runtime's reserved buffer are left out of the
 * categories, which keep only what is in use, grouped and in a fixed order.
 * The percentage is worked out from the token counts when the runtime gives
 * the window but no percentage.
 *
 * @param usage - `Thread.contextUsage()` from agent-engines.
 * @returns The saved shape, or undefined when the report has no usable count.
 */
export function normalizeContextUsage(usage: {
  usedTokens?: unknown
  maxTokens?: unknown
  percent?: unknown
  categories?: ReadonlyArray<{ name?: unknown; tokens?: unknown; kind?: unknown }>
}): TurnContextUsage | undefined {
  const usedTokens = count(usage.usedTokens)
  if (usedTokens === undefined || usedTokens === 0) return undefined
  const maxTokens = count(usage.maxTokens)
  const reported =
    typeof usage.percent === "number" && Number.isFinite(usage.percent)
      ? usage.percent
      : maxTokens
        ? (usedTokens / maxTokens) * 100
        : undefined
  const percent =
    reported === undefined
      ? undefined
      : Math.min(100, Math.max(0, Math.round(reported * 10) / 10))
  const totals = new Map<ContextCategoryLabel, number>()
  for (const category of usage.categories ?? []) {
    if (category.kind !== undefined && category.kind !== "used") continue
    const tokens = count(category.tokens)
    if (!tokens || typeof category.name !== "string") continue
    const label = categoryLabel(category.name)
    totals.set(label, (totals.get(label) ?? 0) + tokens)
  }
  const categories = CATEGORY_ORDER.filter((label) => totals.has(label)).map(
    (label) => ({ label, tokens: totals.get(label)! })
  )
  return {
    usedTokens,
    ...(maxTokens ? { maxTokens } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(categories.length ? { categories } : {}),
  }
}

/**
 * Whether the next turn should compact the thread before it runs.
 *
 * Compaction restates the unit material afterwards, so it is skipped when the
 * last turn was itself the restating one: with a small context window the
 * material alone could pass the threshold, and compacting again would loop.
 *
 * @param usage - Usage saved after the last turn, if any.
 * @param options.canCompact - Whether the chat's provider compacts threads.
 * @param options.restatedLastTurn - Whether the last turn followed a compaction.
 */
export function shouldCompactBeforeTurn(
  usage: TurnContextUsage | undefined | null,
  options: { canCompact: boolean; restatedLastTurn: boolean }
): boolean {
  return (
    options.canCompact &&
    !options.restatedLastTurn &&
    typeof usage?.percent === "number" &&
    usage.percent >= AUTO_COMPACT_PERCENT
  )
}

/** Plain names for the context groups, as the Teach screen shows them. */
export const CONTEXT_CATEGORY_NAMES: Record<ContextCategoryLabel, string> = {
  instructions: "Instructions",
  tools: "Tools",
  conversation: "Lesson so far",
  other: "Other",
}

/**
 * The share of the window one category takes, in whole percent, or undefined
 * when the window size is unknown.
 */
export function categoryPercent(
  usage: TurnContextUsage,
  category: ContextUsageCategory
): number | undefined {
  if (!usage.maxTokens) return undefined
  return Math.round((category.tokens / usage.maxTokens) * 100)
}
