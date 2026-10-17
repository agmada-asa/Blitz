/** Verifies the browser cache that keeps chat quiz answers across reloads. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_QUIZ_ANSWERS,
  MAX_CACHED_QUIZ_REPLIES,
  parseCachedQuizAnswers,
  withQuizAnswer,
} from "../lib/client/chat-quiz-answers.ts"

test("cached answers round-trip and a retry replaces the earlier answer", () => {
  let answers = withQuizAnswer(EMPTY_QUIZ_ANSWERS, "m1", "q1", {
    selectedOptionIds: ["a"],
    correct: false,
  })
  answers = withQuizAnswer(answers, "m1", "q2", {
    selectedOptionIds: ["log n"],
    correct: true,
  })
  answers = withQuizAnswer(answers, "m1", "q1", {
    selectedOptionIds: ["b"],
    correct: true,
  })

  assert.deepEqual(parseCachedQuizAnswers(JSON.stringify(answers)), {
    m1: {
      q1: { selectedOptionIds: ["b"], correct: true },
      q2: { selectedOptionIds: ["log n"], correct: true },
    },
  })
})

test("the cache keeps only the most recently answered replies", () => {
  let answers = EMPTY_QUIZ_ANSWERS
  for (let index = 0; index <= MAX_CACHED_QUIZ_REPLIES; index++)
    answers = withQuizAnswer(answers, `m${index}`, "q1", {
      selectedOptionIds: ["a"],
      correct: true,
    })
  // Answering the oldest kept reply again makes it the newest.
  answers = withQuizAnswer(answers, "m1", "q2", {
    selectedOptionIds: ["b"],
    correct: false,
  })

  const ids = Object.keys(answers)
  assert.equal(ids.length, MAX_CACHED_QUIZ_REPLIES)
  assert.equal(answers.m0, undefined)
  assert.equal(ids.at(-1), "m1")
})

test("malformed stored answers are discarded", () => {
  assert.equal(parseCachedQuizAnswers(null), EMPTY_QUIZ_ANSWERS)
  assert.equal(parseCachedQuizAnswers("not json"), EMPTY_QUIZ_ANSWERS)
  assert.equal(parseCachedQuizAnswers("[1,2]"), EMPTY_QUIZ_ANSWERS)
  assert.deepEqual(
    parseCachedQuizAnswers(
      JSON.stringify({
        m1: {
          good: { selectedOptionIds: ["a"], correct: true },
          noCorrect: { selectedOptionIds: ["a"] },
          badIds: { selectedOptionIds: [1], correct: false },
        },
        m2: "nothing",
      })
    ),
    { m1: { good: { selectedOptionIds: ["a"], correct: true } } }
  )
})
