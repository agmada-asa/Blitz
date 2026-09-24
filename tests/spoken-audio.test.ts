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

test("uses model pronunciations for novel terms while keeping ordinary words", () => {
  assert.equal(
    spokenAudioText("Dr. Ng met the Xenora team and discussed AI.", [
      { written: "Ng", spoken: "ing" },
      { written: "Xenora", spoken: "zeh nor ah" },
      { written: "AI", spoken: "ah eye" },
    ]),
    "Dr. ing met the zeh nor ah team and discussed eigh eye."
  )
})
