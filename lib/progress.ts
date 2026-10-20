/**
 * Turns study activity into the habit signals shown on Home: XP per day with
 * a bonus for runs of right answers, a daily goal, and a streak of days
 * studied that a freeze can protect. Dependency-free so Convex and the client
 * agree on the rules.
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

/** Most questions in one review session, so a backlog never shows as a wall. */
export const REVIEW_SESSION_SIZE = 20

/** Rough time one review question takes, for the session estimate. */
export const REVIEW_SECONDS_PER_QUESTION = 20

/** Right answers in a row before the combo bonus starts. */
export const COMBO_START = 3

/** Answers further apart than this start a new run. */
export const COMBO_GAP_MS = 30 * 60_000

/** Largest combo bonus one answer can earn. */
export const COMBO_MAX_BONUS = 10

/** Streak days that earn one streak freeze. */
export const FREEZE_EVERY_DAYS = 7

/** Most streak freezes the learner can hold. */
export const MAX_FREEZES = 2

/**
 * Bonus XP for a right answer that extends a run: +2 for the third in a row,
 * +4 for the fourth, and so on up to +10.
 * @param run Right answers in a row, including this one.
 */
export function comboBonus(run: number): number {
  if (run < COMBO_START) return 0
  return Math.min(COMBO_MAX_BONUS, (run - COMBO_START + 1) * 2)
}

/** An answer with the minimum needed to score it. */
export type TimedAnswer = { occurredAt: number; correct: boolean }

/**
 * Scores answers in time order: base XP plus the combo bonus. A wrong answer,
 * or a gap longer than `COMBO_GAP_MS`, ends a run.
 * @param answers Answers in any order.
 * @returns Each answer with its XP and run length, oldest first.
 */
export function scoreAnswers<T extends TimedAnswer>(
  answers: readonly T[]
): Array<{ answer: T; xp: number; run: number }> {
  const ordered = [...answers].sort((a, b) => a.occurredAt - b.occurredAt)
  let run = 0
  let last = -Infinity
  return ordered.map((answer) => {
    if (answer.occurredAt - last > COMBO_GAP_MS) run = 0
    last = answer.occurredAt
    if (!answer.correct) {
      run = 0
      return { answer, xp: XP.incorrectAnswer, run }
    }
    run += 1
    return { answer, xp: XP.correctAnswer + comboBonus(run), run }
  })
}

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
  /** Consecutive days studied ending today, or yesterday when today has no study yet. */
  current: number
  /** Whether today's XP goal is met. */
  todayMet: boolean
  /** Whether today already counts toward the streak (any XP earned). */
  todayStudied: boolean
  /** Longest streak in the supplied history. */
  longest: number
  /** Streak freezes held now; each one protects a day with no study. */
  freezes: number
  /** Days in the current streak that a freeze covered, oldest first. */
  frozenDays: string[]
}

/**
 * Computes the streak from XP per local day.
 *
 * Any study keeps the streak: a day counts when it earned XP. The daily goal
 * is a separate target and does not decide the streak. Every
 * `FREEZE_EVERY_DAYS` streak days earn a freeze (at most `MAX_FREEZES`); a
 * past day with no study uses one instead of breaking the streak. An
 * unfinished today never breaks the streak; it simply is not counted yet.
 *
 * @param xpByDay XP earned on each local day.
 * @param today Today's local day key.
 * @param goal XP needed for today's goal.
 */
export function computeStreak(
  xpByDay: ReadonlyMap<string, number>,
  today: string,
  goal: number
): StreakSummary {
  const studied = (day: string) => (xpByDay.get(day) ?? 0) > 0
  const days = [...xpByDay.keys()].filter((day) => day <= today && studied(day)).sort()
  let current = 0
  let longest = 0
  let freezes = 0
  let towardFreeze = 0
  let frozenDays: string[] = []
  /** Counts one studied day toward the streak and the next freeze. */
  const count = () => {
    current += 1
    longest = Math.max(longest, current)
    towardFreeze += 1
    if (towardFreeze >= FREEZE_EVERY_DAYS) {
      towardFreeze = 0
      freezes = Math.min(MAX_FREEZES, freezes + 1)
    }
  }
  // Walk every day from the first studied day to yesterday, then today.
  if (days.length) {
    for (let day = days[0]; day < today; day = nextDayKey(day)) {
      if (studied(day)) count()
      else if (current > 0 && freezes > 0) {
        freezes -= 1
        frozenDays.push(day)
      } else {
        current = 0
        towardFreeze = 0
        frozenDays = []
      }
    }
  }
  const todayStudied = studied(today)
  if (todayStudied) count()
  return {
    current,
    todayMet: (xpByDay.get(today) ?? 0) >= goal,
    todayStudied,
    longest,
    freezes,
    frozenDays,
  }
}

/** Returns the day key after `day`. */
function nextDayKey(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
}

/**
 * One answer counted in a session summary. With `occurredAt`, runs of right
 * answers earn the combo bonus as they do toward the daily goal.
 */
export type SessionAnswer = { conceptId: string; correct: boolean; occurredAt?: number }

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
  /** Longest run of right answers in the session. */
  bestRun: number
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
  let bestRun = 0
  const timed = answers.every((answer) => answer.occurredAt !== undefined)
  if (timed)
    for (const scored of scoreAnswers(
      answers.map((answer) => ({ ...answer, occurredAt: answer.occurredAt! }))
    )) {
      xp += scored.xp - (scored.answer.correct ? XP.correctAnswer : XP.incorrectAnswer)
      bestRun = Math.max(bestRun, scored.run)
    }
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
  return { answered: answers.length, correct, xp, sections, unitsCompleted, concepts, bestRun }
}

/**
 * One line on where today's goal and the streak stand, shared by the Today
 * panel and session summaries so both say the same thing.
 * @param streak The streak summary for today.
 * @param xp XP earned today.
 * @param goal Today's XP goal.
 */
export function streakMessage(streak: StreakSummary, xp: number, goal: number): string {
  if (streak.todayMet)
    return streak.current > 1
      ? `Today's goal is met. ${streak.current}-day streak.`
      : "Today's goal is met."
  const toGoal = Math.max(0, goal - xp)
  if (streak.todayStudied)
    return `Streak kept for today. ${toGoal} XP more meets today's goal.`
  if (streak.current)
    return `Answer one question today to keep your ${streak.current}-day streak.`
  return `Answer one question to start a streak. ${goal} XP meets today's goal.`
}
