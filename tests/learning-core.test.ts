/** Tests the portable answer, review scheduling, and feed-selection rules. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  applyReviewEvent,
  createReviewState,
  evaluateAnswer,
  selectFeedItems,
  type ConceptReviewState,
  type FeedItem,
  type Question,
} from "../lib/learning/core.ts"
import { recallProbability } from "../lib/learning/fsrs.ts"

const NOW = 1_800_000_000_000

/** Builds a review fixture with explicit counts for feed ranking tests. */
function reviewState(
  conceptId: string,
  dueAt: number,
  incorrectCount = 0,
  lastAttemptAt: number | null = NOW - 1_000
): ConceptReviewState {
  return {
    conceptId,
    attemptCount: incorrectCount,
    correctCount: 0,
    incorrectCount,
    consecutiveCorrect: 0,
    lastAttemptAt,
    dueAt,
    lastOutcome: incorrectCount ? "incorrect" : null,
  }
}

/** Builds a minimal feed fixture while keeping all ordering values visible. */
function item(
  id: string,
  conceptId: string,
  kind: "new" | "review",
  projectId = "project-a",
  topicId = "topic-a",
  order = Number(id.replace(/\D/g, ""))
): FeedItem {
  if (kind === "new")
    return { id, conceptId, kind, projectId, topicId, createdAt: NOW, order }
  return {
    id,
    conceptId,
    kind,
    projectId,
    topicId,
    createdAt: NOW,
    order,
    reviewState: reviewState(conceptId, NOW - 1, 0, NOW - 100),
  }
}

/** Adds a presentation format to a feed fixture for interleaving tests. */
function formattedItem(
  id: string,
  conceptId: string,
  format: "explanation" | "question",
  order: number
): FeedItem {
  return {
    ...item(id, conceptId, "new", "project-a", "topic-a", order),
    format,
  }
}

/** Replaces review metadata on a review fixture without widening its kind. */
function withReviewState(
  candidate: FeedItem,
  state: ConceptReviewState
): FeedItem {
  if (candidate.kind !== "review") throw new Error("Expected a review fixture")
  return { ...candidate, reviewState: state }
}

test("single-choice and true-false answers normalize to scored results", () => {
  const single: Question = {
    id: "q1",
    conceptId: "c1",
    prompt: "Pick one",
    type: "single-choice",
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    correctOptionId: "b",
  }
  assert.equal(evaluateAnswer(single, { optionId: "b" }).status, "correct")
  assert.equal(evaluateAnswer(single, "a").status, "incorrect")
  const truth: Question = {
    id: "q2",
    conceptId: "c2",
    prompt: "Is it true?",
    type: "true-false",
    correctAnswer: true,
  }
  assert.equal(evaluateAnswer(truth, true).status, "correct")
  assert.equal(evaluateAnswer(truth, "true").reason, "wrong-answer-shape")
})

test("multiple-answer scoring requires an exact set and rejects duplicates", () => {
  const question: Question = {
    id: "q3",
    conceptId: "c3",
    prompt: "Pick both",
    type: "multiple-answer",
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ],
    correctOptionIds: ["a", "c"],
  }
  assert.equal(evaluateAnswer(question, ["c", "a"]).status, "correct")
  assert.equal(evaluateAnswer(question, ["a"]).status, "incorrect")
  assert.equal(
    evaluateAnswer(question, ["a", "a", "c"]).reason,
    "duplicate-option"
  )
  assert.equal(evaluateAnswer(question, ["a", "x"]).reason, "unknown-option")
})

test("written questions are explicitly project-activity questions", () => {
  const question: Question = {
    id: "q4",
    conceptId: "c4",
    prompt: "Name it",
    type: "written",
    context: "project-activity",
    acceptedAnswers: ["Ada Lovelace"],
  }
  assert.equal(evaluateAnswer(question, "  ADA   LOVELACE ").status, "correct")
})

test("skip and exposure never change review evidence", () => {
  const initial = createReviewState("c1", NOW)
  assert.deepEqual(
    applyReviewEvent(initial, { type: "skip", occurredAt: NOW + 1 }),
    initial
  )
  assert.deepEqual(
    applyReviewEvent(initial, { type: "exposure", occurredAt: NOW + 2 }),
    initial
  )
})

test("correct and incorrect answers progress the deterministic schedule", () => {
  const initial = createReviewState("c1", NOW)
  const correct = applyReviewEvent(initial, {
    type: "answer",
    outcome: "correct",
    occurredAt: NOW,
  })
  assert.equal(correct.attemptCount, 1)
  assert.equal(correct.consecutiveCorrect, 1)
  // FSRS: a first right answer on a new concept is next due in two days.
  assert.equal(correct.dueAt, NOW + 2 * 24 * 60 * 60 * 1000)
  assert.ok(correct.memory && correct.memory.stability > 0)
  const incorrect = applyReviewEvent(correct, {
    type: "answer",
    outcome: "incorrect",
    occurredAt: NOW + 1,
  })
  assert.equal(incorrect.incorrectCount, 1)
  assert.equal(incorrect.consecutiveCorrect, 0)
  assert.equal(incorrect.dueAt, NOW + 1 + 10 * 60 * 1000)
})

test("feed filters, balances due and new material, and avoids immediate concept repeats", () => {
  const candidates: FeedItem[] = [
    item("r1", "c1", "review", "project-a", "topic-a", 1),
    item("r2", "c2", "review", "project-a", "topic-a", 2),
    item("n3", "c3", "new", "project-a", "topic-a", 3),
    item("n4", "c4", "new", "project-b", "topic-b", 4),
    withReviewState(
      item("r5", "c5", "review", "project-a", "topic-a", 5),
      reviewState("c5", NOW + 1)
    ),
  ]
  const selected = selectFeedItems({
    items: candidates,
    now: NOW,
    limit: 4,
    projectId: "project-a",
    topicId: "topic-a",
  })
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["r1", "n3", "r2"]
  )
  assert.notEqual(selected[0]?.conceptId, selected[1]?.conceptId)
  assert.notEqual(selected[1]?.conceptId, selected[2]?.conceptId)
})

test("feed selection is stable and new material fills a no-due review set", () => {
  const candidates: FeedItem[] = [
    withReviewState(item("r1", "c1", "review"), reviewState("c1", NOW + 10)),
    item("n2", "c2", "new", "project-a", "topic-a", 2),
    item("n3", "c3", "new", "project-a", "topic-a", 3),
  ]
  const options = { items: candidates, now: NOW, limit: 3 }
  const first = selectFeedItems(options)
  const second = selectFeedItems(options)
  assert.deepEqual(first, second)
  assert.deepEqual(
    first.map((entry) => entry.id),
    ["n2", "n3"]
  )
  assert.deepEqual(selectFeedItems({ ...options, items: [], limit: 3 }), [])
})

test("feed selection keeps same-concept candidates when diversity is impossible", () => {
  const candidates: FeedItem[] = [
    item("r1", "same-concept", "review", "project-a", "topic-a", 1),
    item("n2", "same-concept", "new", "project-a", "topic-a", 2),
    item("r3", "same-concept", "review", "project-a", "topic-a", 3),
  ]
  const selected = selectFeedItems({
    items: candidates,
    now: NOW,
    limit: 3,
    previousConceptId: "same-concept",
  })
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["r1", "n2", "r3"]
  )
})

test("feed selection interleaves grouped explanations before questions", () => {
  const candidates: FeedItem[] = [
    formattedItem("e1", "c1", "explanation", 1),
    formattedItem("e2", "c2", "explanation", 2),
    formattedItem("e3", "c3", "explanation", 3),
    formattedItem("q1", "c4", "question", 4),
    formattedItem("q2", "c5", "question", 5),
    formattedItem("q3", "c6", "question", 6),
  ]
  const selected = selectFeedItems({ items: candidates, now: NOW, limit: 6 })
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["e1", "e2", "q1", "e3", "q2", "q3"]
  )
  assert.equal(new Set(selected.map((entry) => entry.id)).size, 6)
})

test("feed format preference falls back when every candidate has one format", () => {
  const candidates: FeedItem[] = [
    formattedItem("e1", "c1", "explanation", 1),
    formattedItem("e2", "c2", "explanation", 2),
    formattedItem("e3", "c3", "explanation", 3),
  ]
  assert.deepEqual(
    selectFeedItems({ items: candidates, now: NOW, limit: 3 }).map(
      (entry) => entry.id
    ),
    ["e1", "e2", "e3"]
  )
})

test("formatted feed keeps due same-concept items and excludes not-due reviews", () => {
  const dueExplanation = {
    ...item("r1", "c1", "review", "project-a", "topic-a", 1),
    format: "explanation" as const,
  }
  const sameConceptExplanation = {
    ...item("r2", "same", "review", "project-a", "topic-a", 2),
    format: "explanation" as const,
  }
  const sameConceptQuestion = {
    ...item("r3", "same", "review", "project-a", "topic-a", 3),
    format: "question" as const,
  }
  const dueQuestion = {
    ...item("r4", "c4", "review", "project-a", "topic-a", 4),
    format: "question" as const,
  }
  const notDue = withReviewState(
    {
      ...item("r5", "c5", "review", "project-a", "topic-a", 5),
      format: "question" as const,
    },
    reviewState("c5", NOW + 1)
  )
  const selected = selectFeedItems({
    items: [
      dueExplanation,
      sameConceptExplanation,
      sameConceptQuestion,
      dueQuestion,
      notDue,
    ],
    now: NOW,
    limit: 4,
  })
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["r1", "r2", "r4", "r3"]
  )
  assert.equal(new Set(selected.map((entry) => entry.id)).size, 4)
  assert.equal(
    selected.some((entry) => entry.id === "r5"),
    false
  )
})

test("FSRS grows intervals with each right answer and treats guesses as weaker", () => {
  let state = createReviewState("c1", NOW)
  const gaps: number[] = []
  let at = NOW
  for (let index = 0; index < 4; index++) {
    state = applyReviewEvent(state, { type: "answer", outcome: "correct", occurredAt: at })
    gaps.push(state.dueAt - at)
    at = state.dueAt
  }
  assert.ok(gaps.every((gap, index) => index === 0 || gap > gaps[index - 1]))
  assert.ok(gaps.at(-1)! <= 61 * 24 * 60 * 60 * 1000)

  const sure = applyReviewEvent(createReviewState("c2", NOW), {
    type: "answer",
    outcome: "correct",
    occurredAt: NOW,
  })
  const guessed = applyReviewEvent(createReviewState("c3", NOW), {
    type: "answer",
    outcome: "correct",
    occurredAt: NOW,
    confidence: "guess",
  })
  assert.ok(guessed.dueAt < sure.dueAt)
  assert.ok(guessed.memory!.stability < sure.memory!.stability)
})

test("recall probability falls over time and is zero before any answer", () => {
  const state = applyReviewEvent(createReviewState("c1", NOW), {
    type: "answer",
    outcome: "correct",
    occurredAt: NOW,
  })
  assert.equal(recallProbability(null, NOW), 0)
  const soon = recallProbability(state.memory, NOW + 60_000)
  const later = recallProbability(state.memory, NOW + 20 * 24 * 60 * 60 * 1000)
  assert.ok(soon > 0.95 && soon <= 1)
  assert.ok(later < soon)
})
