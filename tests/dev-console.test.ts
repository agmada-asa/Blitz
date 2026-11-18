/** Verifies the quiet `npm run dev` console: which log lines reach the terminal and how the log is followed. */

import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createProblemFilter,
  followLog,
  isProblemLine,
  plainLine,
  tailLog,
} from "../scripts/dev-console.mjs"

test("shows errors and failed requests but keeps routine output in the log", () => {
  assert.equal(isProblemLine(" GET /api/health 200 in 35ms (next.js: 25ms)"), false)
  assert.equal(isProblemLine("✓ Ready in 247ms"), false)
  assert.equal(isProblemLine("⚠ Fast Refresh had to perform a full reload"), false)
  assert.equal(isProblemLine(""), false)
  assert.equal(isProblemLine(" POST /api/chat 500 in 120ms"), true)
  assert.equal(isProblemLine("⨯ ./app/page.tsx:3:1 Module not found"), true)
  assert.equal(isProblemLine("\x1b[31m✖\x1b[0m TypeScript typecheck via `tsc` failed."), true)
  assert.equal(isProblemLine("Error: connect ECONNREFUSED 127.0.0.1:3210"), true)
})

test("removes colour codes from echoed lines", () => {
  assert.equal(plainLine("\x1b[1m\x1b[31mError\x1b[0m: boom  "), "Error: boom")
})

test("shows a repeated error once per window", () => {
  let time = 0
  const show = createProblemFilter({ repeatWindowMs: 1_000, now: () => time })
  const error = "Error: ENOENT: no such file or directory"
  assert.equal(show(" GET /api/health 200 in 5ms"), undefined)
  assert.equal(show(`\x1b[31m${error}\x1b[0m`), error)
  time = 500
  assert.equal(show(error), undefined)
  assert.equal(show("Error: something else"), "Error: something else")
  time = 1_500
  assert.equal(show(error), error)
})

test("follows new complete lines and the tail of this run's output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-console-"))
  const path = join(directory, "dev.log")
  try {
    writeFileSync(path, "earlier run\n")
    const start = "earlier run\n".length
    const lines: string[] = []
    const stop = followLog(path, start, (line) => lines.push(line), { intervalMs: 10 })
    appendFileSync(path, "first\nsec")
    await new Promise((resolve) => setTimeout(resolve, 40))
    appendFileSync(path, "ond\n")
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    assert.deepEqual(lines, ["first", "second"])
    assert.deepEqual(tailLog(path, start, 1), ["second"])
    assert.deepEqual(tailLog(path, start), ["first", "second"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
