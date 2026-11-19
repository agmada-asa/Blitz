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

/** A weak concept in one unit, as the Practice overview reports it. */
export type WeakConceptEntry<UnitId extends string = string> = {
  title: string
  unitId: UnitId
  unitTitle: string
  /** Share of answers right, or null before any answer. */
  accuracy: number | null
  attempts: number
  /** Whether the unit has practice questions on it; exam-only concepts don't. */
  drillable: boolean
}

/** A weak topic merged across the units it appears in. */
export type WeakTopic<UnitId extends string = string> = {
  title: string
  /** Units the topic appears in, weakest first; the first is where Relearn goes. */
  units: Array<{ id: UnitId; title: string }>
  right: number
  answers: number
  /** Whether the weak-topics drill can ask about it in any of its units. */
  drillable: boolean
}

/**
 * Merges weak concepts that share a title (ignoring case and outer spaces)
 * across units into one topic, since the same idea taught in two units is one
 * thing to relearn. Right answers and answers add up; the unit where the
 * concept is weakest comes first; a topic is drillable when any unit's concept
 * is. Topics are ordered by share of right answers, lowest first, then by
 * most answers.
 */
export function mergeWeakTopics<UnitId extends string>(
  concepts: Array<WeakConceptEntry<UnitId>>
): Array<WeakTopic<UnitId>> {
  const byTitle = new Map<string, { topic: WeakTopic<UnitId>; worst: number }>()
  for (const concept of concepts) {
    const key = concept.title.trim().toLowerCase()
    const accuracy = concept.accuracy ?? 0
    const right = Math.round(accuracy * concept.attempts)
    const unit = { id: concept.unitId, title: concept.unitTitle }
    const entry = byTitle.get(key)
    if (!entry) {
      byTitle.set(key, {
        topic: {
          title: concept.title,
          units: [unit],
          right,
          answers: concept.attempts,
          drillable: concept.drillable,
        },
        worst: accuracy,
      })
      continue
    }
    entry.topic.right += right
    entry.topic.answers += concept.attempts
    entry.topic.drillable ||= concept.drillable
    if (entry.topic.units.some((existing) => existing.id === unit.id)) continue
    if (accuracy < entry.worst) {
      entry.topic.units.unshift(unit)
      entry.worst = accuracy
    } else entry.topic.units.push(unit)
  }
  /** Share of a topic's answers that were right; 0 before any answer. */
  const share = (topic: WeakTopic<UnitId>) => (topic.answers ? topic.right / topic.answers : 0)
  return [...byTitle.values()]
    .map((entry) => entry.topic)
    .sort((a, b) => share(a) - share(b) || b.answers - a.answers)
}
