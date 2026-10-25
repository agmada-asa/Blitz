/**
 * Writes practice questions for a unit through the configured provider.
 *
 * Shared by the Practice route (on request) and the chat route (the automatic
 * first bank once a unit is under way). Runs are tracked in Convex so the
 * Practice screen can follow them and only one runs per unit at a time.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"
import { resolveAiTaskSelection } from "../ai-model-settings.ts"
import { quizPayload } from "../interactive-blocks.ts"
import {
  buildQuestionBankPrompt,
  DEFAULT_BANK_BATCH,
  parseQuestionBank,
  QUESTION_BANK_SCHEMA,
} from "../practice.ts"
import { loadSavedAiModelSettings } from "./ai-model-settings.ts"
import { serverConvexClient } from "./convex.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"

/** Longest a single provider turn may take. */
const GENERATION_TIMEOUT_MS = 540_000

/** Returns a short learner-facing reason for a failed run. */
function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (/usage limit|rate limit|quota/i.test(message))
    return "Your AI subscription's usage limit was reached. Try again later."
  if (/timed? ?out/i.test(message)) return "Writing questions took too long. Try again."
  if (/no JSON|questions list|JSON/i.test(message))
    return "The questions came back in the wrong format. Try again."
  return "Questions could not be written. Try again."
}

/**
 * Writes one batch of practice questions and concept recaps for a unit and
 * saves the valid ones. Never throws: failures are recorded on the run with a
 * learner-facing message.
 * @param unitId Unit whose material the questions cover.
 * @param generationId Run started by `practice.startGeneration`.
 * @param count Questions to request.
 */
export async function runQuestionBank(
  unitId: Id<"units">,
  generationId: Id<"questionGenerations">,
  count: number
): Promise<void> {
  const client = serverConvexClient()
  const directory = await mkdtemp(join(tmpdir(), "blitz-practice-"))
  try {
    const context = await client.query(api.practice.generationContext, { unitId })
    if (!context) throw new Error("Unit not found")
    if (!context.sources.length) throw new Error("This unit has no readable material yet")
    const settings = await loadSavedAiModelSettings(client)
    const selection = resolveAiTaskSelection(settings, "cardGeneration", {
      providerEnvironmentFallback: process.env.BLITZ_REPLY_PROVIDER,
      modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
      effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
    })
    const result = await runProviderTextTurn({
      providerId: selection.providerId,
      model: selection.model,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      workspaceDirectory: directory,
      prompt: buildQuestionBankPrompt({ ...context, count }),
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: GENERATION_TIMEOUT_MS,
      outputSchema: QUESTION_BANK_SCHEMA,
    })
    const { questions, recaps, rejected } = parseQuestionBank(result)
    if (!questions.length) throw new Error("No valid questions in JSON")
    await client.mutation(api.practice.saveGeneratedQuestions, {
      generationId,
      rejectedCount: rejected,
      recaps,
      questions: questions.map(quizPayload),
    })
    await client.mutation(api.practice.finishGeneration, { generationId })
  } catch (error) {
    console.error("Practice questions could not be written", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    await client
      .mutation(api.practice.finishGeneration, { generationId, error: failureMessage(error) })
      .catch(() => undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Starts a unit's first question bank in the background unless it already
 * has one or a run is under way. Used as soon as a Teach session has its
 * outline, so Practice and Review have material without being asked.
 */
export async function startFirstQuestionBank(unitId: Id<"units">): Promise<void> {
  const { generationId, alreadyRunning } = await serverConvexClient().mutation(
    api.practice.startGeneration,
    { unitId, count: DEFAULT_BANK_BATCH, onlyIfEmpty: true }
  )
  if (!alreadyRunning) void runQuestionBank(unitId, generationId, DEFAULT_BANK_BATCH)
}
