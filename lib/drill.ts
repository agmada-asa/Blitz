/**
 * Decides which practice questions come next and how strong each concept is,
 * so weak and forgotten material returns first. Dependency-free so Convex
 * queries and clients can share it.
 */

/** Learner-facing strength of one concept, from its answer history. */
export type ConceptStrength = "new" | "weak" | "learning" | "strong"

/** Answer history used to judge a concept. */
export type ConceptHistory = {
  attempts: number
  correct: number
  consecutiveCorrect: number
  lastOutcome?: "correct" | "incorrect"
}

/**
 * Classifies a concept so practice can target what is not sticking.
 *
 * - `new`: never answered.
 * - `weak`: the last answer was wrong, or under 60% correct after two or more attempts.
 * - `strong`: at least three correct in a row and at least 80% correct overall.
 * - `learning`: everything in between.
 */
export function conceptStrength(history: ConceptHistory): ConceptStrength {
  if (history.attempts <= 0) return "new"
  const accuracy = history.correct / history.attempts
  if (history.lastOutcome === "incorrect" || (history.attempts >= 2 && accuracy < 0.6))
    return "weak"
  if (history.consecutiveCorrect >= 3 && accuracy >= 0.8) return "strong"
  return "learning"
}

/** One question that a drill could ask, with the history needed to rank it. */
export type DrillCandidate = {
  itemId: string
  conceptId: string
  /** Order the question was created in; older questions break ties first. */
  createdAt: number
  /** Outcome of the latest answer to this exact question. */
  lastOutcome?: "correct" | "incorrect"
  lastAnsweredAt?: number
  /** Strength of the question's concept. */
  strength: ConceptStrength
  /** When the concept's review falls due. */
  conceptDueAt?: number
}

/** Ranking bucket; lower buckets are asked first. */
function drillBucket(candidate: DrillCandidate, now: number): number {
  if (candidate.lastOutcome === "incorrect") return 0
  if (candidate.lastOutcome && (candidate.conceptDueAt ?? Infinity) <= now) return 1
  if (!candidate.lastOutcome) return candidate.strength === "weak" ? 2 : 3
  return 4
}

/** Weak concepts sort before learning, new, and strong ones within a bucket. */
const strengthOrder: Record<ConceptStrength, number> = {
  weak: 0,
  learning: 1,
  new: 2,
  strong: 3,
}

/**
 * Chooses the next drill questions.
 *
 * Questions answered wrongly come first, then questions whose concept is due
 * for review, then unanswered questions (weak concepts first), then the rest
 * (longest since answered first). Within that order, consecutive questions
 * avoid repeating a concept when another concept is available.
 *
 * @param candidates Every question in scope.
 * @param now Current time for review due dates.
 * @param limit Most questions to return.
 * @returns Item IDs in the order they should be asked.
 */
export function selectDrillQuestions(
  candidates: readonly DrillCandidate[],
  now: number,
  limit: number
): string[] {
  if (limit <= 0) return []
  const ranked = [...candidates].sort(
    (a, b) =>
      drillBucket(a, now) - drillBucket(b, now) ||
      strengthOrder[a.strength] - strengthOrder[b.strength] ||
      (a.lastAnsweredAt ?? 0) - (b.lastAnsweredAt ?? 0) ||
      a.createdAt - b.createdAt
  )
  const chosen: DrillCandidate[] = []
  const remaining = ranked.slice(0, Math.max(limit * 4, limit))
  while (chosen.length < limit && remaining.length) {
    const previous = chosen.at(-1)?.conceptId
    // Prefer the best-ranked question from a different concept, but never skip
    // a whole bucket to find one.
    const headBucket = drillBucket(remaining[0], now)
    const index = remaining.findIndex(
      (candidate) =>
        candidate.conceptId !== previous && drillBucket(candidate, now) === headBucket
    )
    chosen.push(remaining.splice(index >= 0 ? index : 0, 1)[0])
  }
  return chosen.map((candidate) => candidate.itemId)
}

/**
 * Counts how many more right answers in a row would make a concept strong
 * under `conceptStrength`: at least three in a row and 80% accuracy overall.
 * Used for near-miss prompts such as "2 more right and Heaps is strong".
 * @returns 0 when the concept is already strong.
 */
export function answersToStrong(history: ConceptHistory): number {
  // With n more right answers: streak + n >= 3, and
  // (correct + n) / (attempts + n) >= 0.8, which simplifies to n >= 4a - 5c.
  const streak = history.lastOutcome === "incorrect" ? 0 : history.consecutiveCorrect
  return Math.max(0, 3 - streak, 4 * history.attempts - 5 * history.correct)
}
