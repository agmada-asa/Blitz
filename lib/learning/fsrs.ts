/**
 * Wraps the FSRS spaced-repetition model (`ts-fsrs`) behind the small, plain
 * data shapes Blitz stores, so review scheduling stays deterministic and can
 * be replayed from the answer log.
 *
 * FSRS models each concept's memory with a stability (days until recall falls
 * to 90%) and a difficulty, and schedules the next review for when recall is
 * predicted to drop to the target retention. Blitz grades every scored answer
 * as one of three ratings: wrong is `Again`, right but guessed is `Hard`, and
 * right is `Good`. Fuzz is off so replaying the same answers always gives the
 * same schedule.
 */

import {
  createEmptyCard,
  forgetting_curve,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs"

/** Share of reviews FSRS aims to have recalled when they fall due. */
export const TARGET_RETENTION = 0.9

/** Longest gap between reviews, in days, so exam material never drifts far. */
export const MAXIMUM_INTERVAL_DAYS = 60

/** How sure the learner was when answering; a guess that lands is weaker evidence. */
export type AnswerConfidence = "sure" | "guess"

/** The FSRS memory state Blitz keeps for one concept. */
export interface ReviewMemory {
  /** Days until predicted recall falls to the target retention. */
  readonly stability: number
  /** Intrinsic difficulty from 1 (easy) to 10 (hard). */
  readonly difficulty: number
  /** FSRS phase: 0 new, 1 learning, 2 review, 3 relearning. */
  readonly phase: 0 | 1 | 2 | 3
  /** Scored reviews applied so far. */
  readonly reps: number
  /** Times the concept was forgotten after reaching review. */
  readonly lapses: number
  /** Position within the short learning or relearning steps. */
  readonly learningSteps: number
  /** Days FSRS scheduled at the latest review. */
  readonly scheduledDays: number
  /** Timestamp of the latest review. */
  readonly lastReviewAt: number
}

const scheduler = fsrs(
  generatorParameters({
    request_retention: TARGET_RETENTION,
    maximum_interval: MAXIMUM_INTERVAL_DAYS,
    enable_fuzz: false,
    enable_short_term: true,
    // One short step: a miss (or a guess on a new concept) comes back within
    // the session; a first right answer goes straight to a multi-day interval.
    learning_steps: ["10m"],
    relearning_steps: ["10m"],
  })
)

/** Converts an answer outcome and confidence into the FSRS grade it earns. */
export function ratingFor(
  outcome: "correct" | "incorrect",
  confidence?: AnswerConfidence
): Grade {
  if (outcome === "incorrect") return Rating.Again
  return confidence === "guess" ? Rating.Hard : Rating.Good
}

/** Rebuilds a `ts-fsrs` card from stored memory, or a new card before the first answer. */
function cardFrom(memory: ReviewMemory | null, at: number): Card {
  if (!memory) return createEmptyCard(new Date(at))
  return {
    ...createEmptyCard(new Date(memory.lastReviewAt)),
    due: new Date(memory.lastReviewAt),
    stability: memory.stability,
    difficulty: memory.difficulty,
    state: memory.phase as State,
    reps: memory.reps,
    lapses: memory.lapses,
    learning_steps: memory.learningSteps,
    scheduled_days: memory.scheduledDays,
    last_review: new Date(memory.lastReviewAt),
  }
}

/**
 * Applies one scored answer to a concept's memory.
 * @param memory The memory before this answer, or null for a concept never answered.
 * @param at When the answer happened; must not be earlier than `memory.lastReviewAt`.
 * @returns The new memory and the timestamp the concept next falls due.
 */
export function reviewMemory(
  memory: ReviewMemory | null,
  outcome: "correct" | "incorrect",
  at: number,
  confidence?: AnswerConfidence
): { memory: ReviewMemory; dueAt: number } {
  const when = new Date(Math.max(at, memory?.lastReviewAt ?? at))
  const { card } = scheduler.next(
    cardFrom(memory, when.getTime()),
    when,
    ratingFor(outcome, confidence)
  )
  return {
    memory: {
      stability: card.stability,
      difficulty: card.difficulty,
      phase: card.state as ReviewMemory["phase"],
      reps: card.reps,
      lapses: card.lapses,
      learningSteps: card.learning_steps,
      scheduledDays: card.scheduled_days,
      lastReviewAt: when.getTime(),
    },
    dueAt: card.due.getTime(),
  }
}

/**
 * Predicted probability (0–1) that the learner recalls a concept now.
 * @returns 0 for a concept never answered.
 */
export function recallProbability(
  memory: Pick<ReviewMemory, "stability" | "lastReviewAt"> | null | undefined,
  now: number
): number {
  if (!memory || !(memory.stability > 0)) return 0
  const elapsedDays = Math.max(0, now - memory.lastReviewAt) / 86_400_000
  return forgetting_curve(scheduler.parameters.w, elapsedDays, memory.stability)
}

/** How ready a module is, from the predicted recall of each of its concepts. */
export type Readiness = {
  /** Concepts in the module. */
  concepts: number
  /** Concepts answered at least once. */
  practised: number
  /** Mean predicted recall of practised concepts now, 0–1. */
  recallOfPractised: number
  /** Expected share of all concepts recalled now, 0–1; unpractised ones count as 0. */
  readiness: number
}

/**
 * Estimates a module's readiness: the share of its concepts the learner would
 * likely recall today. Concepts never answered count as not recalled, so the
 * figure rises with both coverage and memory.
 * @param memories One entry per concept: its FSRS memory, or null if never answered.
 */
export function readiness(
  memories: ReadonlyArray<Pick<ReviewMemory, "stability" | "lastReviewAt"> | null | undefined>,
  now: number
): Readiness {
  let practised = 0
  let recalled = 0
  for (const memory of memories) {
    if (!memory) continue
    practised += 1
    recalled += recallProbability(memory, now)
  }
  return {
    concepts: memories.length,
    practised,
    recallOfPractised: practised ? recalled / practised : 0,
    readiness: memories.length ? recalled / memories.length : 0,
  }
}
