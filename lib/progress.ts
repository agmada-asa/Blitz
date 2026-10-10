/**
 * Turns study activity into the habit signals shown on Home: XP per day, a
 * daily goal, and a streak of days that met it. Dependency-free so Convex and
 * the client agree on the rules.
 */

/** XP awarded per kind of activity. Effort counts, so a wrong answer still earns some. */
export const XP = {
  correctAnswer: 10,
  incorrectAnswer: 4,
  section: 25,
  unit: 50,
} as const

/** Daily goal used until the learner chooses another. About one section plus a short drill. */
export const DEFAULT_DAILY_GOAL_XP = 50

/** Local hour of the daily reminder until the learner chooses another. */
export const DEFAULT_REMINDER_HOUR = 19

/** Smallest and largest daily goals the learner can choose. */
export const DAILY_GOAL_RANGE = { min: 10, max: 500 } as const

/** Milliseconds in one day. */
const DAY_MS = 86_400_000

/**
 * Returns the learner's local calendar day for a timestamp as `YYYY-MM-DD`.
 * @param timestamp Milliseconds since the epoch.
 * @param tzOffsetMinutes The browser's `Date#getTimezoneOffset()` (minutes behind UTC).
 */
export function localDayKey(timestamp: number, tzOffsetMinutes: number): string {
  return new Date(timestamp - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** Returns the day key `days` before `day`. */
export function previousDayKey(day: string, days = 1): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)
}

/** Streak state for Home. */
export type StreakSummary = {
  /** Consecutive goal-met days ending today, or yesterday when today is not met yet. */
  current: number
  /** Whether today's goal is already met. */
  todayMet: boolean
  /** Longest run of goal-met days in the supplied history. */
  longest: number
}

/**
 * Computes the streak from XP per local day.
 *
 * A day counts when its XP reaches the goal. An unfinished today does not
 * break the streak; it simply is not counted yet.
 *
 * @param xpByDay XP earned on each local day.
 * @param today Today's local day key.
 * @param goal XP needed for a day to count.
 */
export function computeStreak(
  xpByDay: ReadonlyMap<string, number>,
  today: string,
  goal: number
): StreakSummary {
  const met = (day: string) => (xpByDay.get(day) ?? 0) >= goal
  const todayMet = met(today)
  let current = 0
  let day = todayMet ? today : previousDayKey(today)
  while (met(day)) {
    current += 1
    day = previousDayKey(day)
  }
  let longest = 0
  let run = 0
  const days = [...xpByDay.keys()].sort()
  let last: string | undefined
  for (const key of days) {
    if (!met(key)) {
      run = 0
      last = key
      continue
    }
    run = last && previousDayKey(key) === last && met(last) ? run + 1 : 1
    longest = Math.max(longest, run)
    last = key
  }
  return { current, todayMet, longest: Math.max(longest, current) }
}
