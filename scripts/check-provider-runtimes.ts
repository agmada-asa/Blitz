/**
 * Checks the installed provider runtimes for what only Blitz can check.
 *
 * Codex and Claude Code run through agent-engines, which pins the Codex
 * protocol, refuses runtimes older than it supports, and runs its own weekly
 * `check:runtimes` against the latest CLIs. This script covers the rest:
 *
 * - OpenCode's version against Blitz's ACP requirement
 *   (`lib/server/providers/runtime-compat.ts`);
 * - the live Codex model catalogue against Blitz's fallback model list, when
 *   Codex is signed in.
 *
 * No model turn is started. Exits with status 1 when any check finds drift.
 *
 * Usage: npm run check:runtimes -- [--ci]
 *   --ci  Treat a missing OpenCode as a failure and skip the Codex catalogue.
 *         Used by the weekly workflow, which installs the latest OpenCode
 *         without signing in to anything.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import {
  OPENCODE_VERSION_REQUIREMENT,
  checkOpenCodeVersion,
} from "../lib/server/providers/runtime-compat.ts"

const run = promisify(execFile)

/** Upper bound for each CLI call so a hung runtime cannot stall the check. */
const COMMAND_TIMEOUT_MS = 30_000

/** Whether this run is the unattended weekly check. */
const ciMode = process.argv.includes("--ci")

/** Accumulates report lines and whether any of them is a failure. */
const report = { lines: [] as string[], failed: false }

/** Adds one report line, marking the run failed when `problem` is true. */
function note(line: string, problem = false): void {
  report.lines.push(line)
  if (problem) report.failed = true
}

/** Checks OpenCode's version against Blitz's requirement. */
async function checkOpenCode(): Promise<void> {
  const executable = process.env.BLITZ_OPENCODE_COMMAND?.trim() || "opencode"
  let output: string
  try {
    const { stdout, stderr } = await run(executable, ["--version"], {
      timeout: COMMAND_TIMEOUT_MS,
    })
    output = `${stdout}${stderr}`
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    note(
      missing
        ? "OpenCode: not installed"
        : `OpenCode: \`${executable} --version\` failed`,
      !missing || ciMode
    )
    return
  }
  const check = checkOpenCodeVersion(output)
  const { minimum, sameMajor } = OPENCODE_VERSION_REQUIREMENT
  note(
    `OpenCode ${check.version ?? "(unknown version)"}: ${
      check.supported ? "supported" : "UNSUPPORTED"
    } (needs ${minimum}+${sameMajor ? ` within v${minimum.split(".")[0]}` : ""})`,
    !check.supported
  )
}

/**
 * Compares the signed-in Codex model catalogue with Blitz's fallback list.
 * Loaded lazily: it needs the app's dependencies, which the weekly run skips.
 */
async function checkCodexModels(): Promise<void> {
  const [
    { diffModelCatalog, hasModelCatalogDrift },
    { CODEX_MODEL_OPTIONS },
    { listCodexModels },
    { createCodexEngine },
  ] = await Promise.all([
    import("agent-engines"),
    import("../lib/ai-model-settings.ts"),
    import("../lib/server/providers/codex-models.ts"),
    import("../lib/server/providers/engines.ts"),
  ])
  const engine = createCodexEngine()
  const state = await engine.availability()
  await engine.close()
  if (!state.ready) {
    note(`Codex models: skipped (${state.message})`)
    return
  }
  let live
  try {
    live = await listCodexModels({ requestTimeoutMs: COMMAND_TIMEOUT_MS })
  } catch (error) {
    note(
      `Codex models: could not read the catalogue (${error instanceof Error ? error.message : "unknown error"})`,
      true
    )
    return
  }
  const drift = diffModelCatalog(
    CODEX_MODEL_OPTIONS.map((model) => ({
      id: model.id,
      efforts: model.reasoningEfforts,
    })),
    live.map((model) => ({ id: model.id, efforts: model.reasoningEfforts }))
  )
  if (!hasModelCatalogDrift(drift)) {
    note(
      `Codex models: fallback list matches the live catalogue (${live.length})`
    )
    return
  }
  note(
    "Codex models: DRIFT, update CODEX_MODEL_OPTIONS in lib/ai-model-settings.ts",
    true
  )
  for (const id of drift.added) note(`  + ${id} (live only)`, true)
  for (const id of drift.removed) note(`  - ${id} (no longer served)`, true)
  for (const change of drift.changed)
    note(
      `  ~ ${change.id}: fallback [${change.expected.join(", ")}], live [${change.live.join(", ")}]`,
      true
    )
}

/** Runs every check and prints a report. */
async function main(): Promise<void> {
  await checkOpenCode()
  if (!ciMode) await checkCodexModels()
  console.log(report.lines.join("\n"))
  console.log(
    report.failed
      ? "\nProvider runtimes have drifted from what Blitz supports."
      : "\nProvider runtimes match what Blitz supports."
  )
  process.exitCode = report.failed ? 1 : 0
}

await main()
