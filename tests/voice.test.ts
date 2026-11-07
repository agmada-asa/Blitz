/** Verifies streaming boundaries and spoken quiz matching preserve structured content and avoid guesses. */
import assert from "node:assert/strict"
import test from "node:test"
import { pieceEnd, speakablePieces } from "../lib/speech-pieces.ts"

test("speech waits for open math and fenced code", () => {
  assert.equal(pieceEnd("Here is the formula $a. b"), -1)
  assert.equal(pieceEnd("```ts\nconst x = 'hello. world'"), -1)
  assert.equal(pieceEnd("$$\na. b\n"), -1)
  assert.equal(pieceEnd("| a. b | c |"), -1)
})

test("pieces end only at whole sentences, never at an opening clause", () => {
  const text = "When the loop ends, the result is ready. Next sentence"
  assert.equal(text.slice(0, pieceEnd(text)), "When the loop ends, the result is ready. ")
  assert.equal(pieceEnd("When the loop ends, the result"), -1)
  assert.equal(pieceEnd("Use a hash map, e.g. a dict"), -1)
})

test("overlong sentences split at a clause break rather than mid-phrase", () => {
  const clause = "the load only has the value at the end of its memory stage"
  const sentence = `${clause}; ${clause}, but the add wants it at the start of its execute stage, ${clause}.`
  const pieces = speakablePieces(sentence, 140)
  assert.ok(pieces.length > 1)
  for (const piece of pieces.slice(0, -1)) assert.match(piece, /[;,]$/)
  assert.equal(pieces.join(" "), sentence)
  assert.deepEqual(speakablePieces("Short and whole."), ["Short and whole."])
})
