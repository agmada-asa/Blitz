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

/** One answer counted in a session summary. */
export type SessionAnswer = { conceptId: string; correct: boolean }

/** How one concept went during a session. */
export type SessionConceptTally = { conceptId: string; answered: number; correct: number }

/** What a study session added up to. */
export type SessionTotals = {
  answered: number
  correct: number
  /** XP from answers and Teach milestones, using the same rules as the daily goal. */
  xp: number
  sections: number
  unitsCompleted: number
  /** Concepts answered, those with mistakes first, then the most practised. */
  concepts: SessionConceptTally[]
}

/**
 * Adds up a session's answers and Teach milestones.
 * @param answers Answers recorded since the session started, in any order.
 * @param milestones Teach milestones recorded since the session started.
 * @returns Totals and a per-concept tally.
 */
export function summarizeSession(
  answers: readonly SessionAnswer[],
  milestones: ReadonlyArray<{ kind: "section" | "unit" }>
): SessionTotals {
  const byConcept = new Map<string, SessionConceptTally>()
  let correct = 0
  let xp = 0
  for (const answer of answers) {
    const tally = byConcept.get(answer.conceptId) ?? {
      conceptId: answer.conceptId,
      answered: 0,
      correct: 0,
    }
    tally.answered += 1
    if (answer.correct) {
      tally.correct += 1
      correct += 1
      xp += XP.correctAnswer
    } else xp += XP.incorrectAnswer
    byConcept.set(answer.conceptId, tally)
  }
  let sections = 0
  let unitsCompleted = 0
  for (const milestone of milestones) {
    if (milestone.kind === "unit") {
      unitsCompleted += 1
      xp += XP.unit
    } else {
      sections += 1
      xp += XP.section
    }
  }
  const concepts = [...byConcept.values()].sort(
    (a, b) =>
      b.answered - b.correct - (a.answered - a.correct) || b.answered - a.answered
  )
  return { answered: answers.length, correct, xp, sections, unitsCompleted, concepts }
}
