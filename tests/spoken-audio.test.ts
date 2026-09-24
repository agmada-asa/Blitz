/** Verifies the final speech cleanup shared by audiobook and podcast scripts. */

import assert from "node:assert/strict"
import test from "node:test"

import { spokenAudioText } from "../lib/spoken-audio.ts"

test("writes common abbreviations in speakable form without changing names", () => {
  assert.equal(
    spokenAudioText("Al Capone discussed AI vs. ML vs LLMs."),
    "Al Capone discussed A I versus M L versus large language models."
  )
})
