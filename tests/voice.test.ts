/** Verifies streaming boundaries and spoken quiz matching preserve structured content and avoid guesses. */
import assert from "node:assert/strict"
import test from "node:test"
import { pieceEnd } from "../lib/speech-pieces.ts"
import { spokenQuizAnswer } from "../lib/voice-quiz.ts"

test("speech waits for open math and fenced code", () => {
  assert.equal(pieceEnd("Here is the formula $a. b"), -1)
  assert.equal(pieceEnd("```ts\nconst x = 'hello. world'"), -1)
  assert.equal(pieceEnd("$$\na. b\n"), -1)
  assert.equal(pieceEnd("| a. b | c |"), -1)
})

test("opening clauses start early and subsequent pieces wait for sentences", () => {
  const text = "When the loop ends, the result is ready. Next sentence"
  assert.equal(text.slice(0, pieceEnd(text, true)), "When the loop ends, ")
  assert.equal(text.slice(0, pieceEnd(text)), "When the loop ends, the result is ready. ")
})

test("quiz labels and controls are unambiguous", () => {
  const options = [{ text: "Linear" }, { text: "Logarithmic" }]
  assert.equal(spokenQuizAnswer("B.", options), 1)
  assert.equal(spokenQuizAnswer("option two", options), 1)
  assert.equal(spokenQuizAnswer("maybe one or two", options), null)
  assert.equal(spokenQuizAnswer("I don't know", options), "skip")
  assert.equal(spokenQuizAnswer("repeat", options), "repeat")
})
