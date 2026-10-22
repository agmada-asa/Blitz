/** Verifies readable scripts become predictable input for the local voice. */

import assert from "node:assert/strict"
import test from "node:test"

import { spokenAudioText } from "../lib/spoken-audio.ts"

test("writes common abbreviations phonetically without changing names", () => {
  assert.equal(
    spokenAudioText("Al Capone discussed AI vs. ML vs LLMs."),
    "Al Capone discussed eigh eye versus em ell versus ell ell ems."
  )
})

test("leaves ordinary words, technical terms, and names for the speech engine", () => {
  const text =
    "Registers store binary data. The processor uses an interface and instruction set architecture. Dr. Ng met the Xenora team."
  assert.equal(spokenAudioText(text), text)
})

test("matches checked abbreviations as whole terms without changing nearby words", () => {
  assert.equal(
    spokenAudioText(
      "RAIL AIs LLMstack HTML Al Capone. AI, ML; LLM and LLMs vs. syntax."
    ),
    "RAIL AIs LLMstack HTML Al Capone. eigh eye, em ell; ell ell em and ell ell ems versus syntax."
  )
})

test("normalizes whitespace while keeping punctuation and normal spelling", () => {
  assert.equal(
    spokenAudioText("  Verification.\n\nBinary  arithmetic and\talgorithms.  "),
    "Verification. Binary arithmetic and algorithms."
  )
})
