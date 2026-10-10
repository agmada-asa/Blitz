/**
 * Writes a batch of exam-style practice questions for one unit.
 *
 * The route records a run and returns at once; the tutor writes the questions
 * after the response with `after()`, and the Practice screen follows the run
 * through Convex. Questions are validated with the lesson quiz rules before
 * they are saved, and invalid ones are dropped.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after } from "next/server"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { resolveAiTaskSelection } from "@/lib/ai-model-settings"
import {
  buildQuestionBankPrompt,
  DEFAULT_BANK_BATCH,
  MAX_BANK_BATCH,
  parseQuestionBank,
} from "@/lib/practice"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import { serverConvexClient } from "@/lib/server/convex"
import { runProviderTextTurn } from "@/lib/server/providers/run-text-turn"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js because the run starts a local provider process. */
export const runtime = "nodejs"
/** Allows the background run up to ten minutes. */
export const maxDuration = 600

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

/** Runs one generation after the response has been sent. */
async function runGeneration(unitId: Id<"units">, generationId: Id<"questionGenerations">, count: number) {
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
    })
    const { questions, rejected } = parseQuestionBank(result.text)
    if (!questions.length) throw new Error("No valid questions in JSON")
    await client.mutation(api.practice.saveGeneratedQuestions, {
      generationId,
      rejectedCount: rejected,
      questions: questions.map((question) => ({
        concept: question.concept,
        type: question.type,
        question: question.question,
        options: question.options,
        correctOptionIds: question.correctOptionIds,
        explanation: question.explanation,
      })),
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

/** Starts a question-bank run for a unit and returns its ID immediately. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to write questions" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as {
    unitId?: unknown
    count?: unknown
  } | null
  if (typeof body?.unitId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(body.unitId))
    return Response.json({ error: "Choose a unit" }, { status: 400 })
  const count =
    typeof body.count === "number" && Number.isFinite(body.count)
      ? Math.max(1, Math.min(MAX_BANK_BATCH, Math.round(body.count)))
      : DEFAULT_BANK_BATCH
  const unitId = body.unitId as Id<"units">
  try {
    const { generationId, alreadyRunning } = await serverConvexClient().mutation(
      api.practice.startGeneration,
      { unitId, count }
    )
    if (!alreadyRunning) after(() => runGeneration(unitId, generationId, count))
    return Response.json({ generationId, alreadyRunning })
  } catch {
    return Response.json({ error: "Questions could not be started. Try again." }, { status: 503 })
  }
}
