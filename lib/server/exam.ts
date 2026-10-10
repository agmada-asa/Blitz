/**
 * Runs exam mode's background provider work: extracting a past paper's
 * questions, writing a mock paper, and marking an attempt's written answers.
 *
 * Each job is one provider turn in a temporary read-only directory, started
 * by an API route with `after()` so the request returns at once. Runs are
 * tracked in Convex (`convex/exam.ts`), which the Practice and exam screens
 * follow live. A run never throws: failures are saved with a learner-facing
 * message so the screen can offer a retry.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"
import { resolveAiTaskSelection } from "../ai-model-settings.ts"
import {
  buildExamGradingPrompt,
  buildMockExamPrompt,
  buildPastPaperPrompt,
  parseExamGrading,
  parseExamPaper,
  type ExamQuestion,
} from "../exam.ts"
import { loadSavedAiModelSettings } from "./ai-model-settings.ts"
import { serverConvexClient } from "./convex.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"

/**
 * Returns a request value when it looks like a Convex document ID, so exam
 * routes can reject malformed input before calling Convex.
 */
export function requestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9]{1,64}$/.test(value) ? value : null
}

/** Longest a single provider turn may take; under the ten-minute run lease. */
const TURN_TIMEOUT_MS = 540_000

/** Error whose message is safe to show the learner as is. */
class ExamRunError extends Error {}

/**
 * Sends one prompt to the provider chosen for question writing and returns
 * the reply text. The provider works in an empty temporary directory with a
 * read-only sandbox and no web search, so it only sees the prompt.
 */
async function runExamTurn(prompt: string): Promise<string> {
  const client = serverConvexClient()
  const directory = await mkdtemp(join(tmpdir(), "blitz-exam-"))
  try {
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
      prompt,
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: TURN_TIMEOUT_MS,
    })
    return result.text
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Returns a short learner-facing reason for a failed run. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ExamRunError) return error.message
  const message = error instanceof Error ? error.message : ""
  if (/usage limit|rate limit|quota/i.test(message))
    return "Your AI subscription's usage limit was reached. Try again later."
  if (/timed? ?out/i.test(message)) return "This took too long. Try again."
  if (/JSON|questions list|grades list/i.test(message))
    return "The reply came back in the wrong format. Try again."
  return fallback
}

/** Converts a validated question into the stored shape, mapping its unit key to a unit ID. */
function storedQuestion(question: ExamQuestion, unitIds: Map<string, Id<"units">>) {
  const unitId = question.unitKey ? unitIds.get(question.unitKey) : undefined
  return {
    id: question.id,
    number: question.number,
    marks: question.marks,
    type: question.type,
    prompt: question.prompt,
    concept: question.concept,
    ...(question.options ? { options: question.options } : {}),
    ...(question.correctOptionIds ? { correctOptionIds: question.correctOptionIds } : {}),
    ...(question.explanation ? { explanation: question.explanation } : {}),
    ...(question.modelAnswer ? { modelAnswer: question.modelAnswer } : {}),
    ...(question.markScheme ? { markScheme: question.markScheme } : {}),
    ...(question.answerSource ? { answerSource: question.answerSource } : {}),
    ...(unitId ? { unitId } : {}),
  }
}

/**
 * Prepares a paper: extracts a past paper's questions, or writes a mock
 * paper, and saves the valid questions. Does nothing when a newer run has
 * replaced this one.
 * @param paperId Paper to prepare.
 * @param runStartedAt Identifies this run; returned by the create or restart mutation.
 */
export async function runPaperPreparation(
  paperId: Id<"examPapers">,
  runStartedAt: number
): Promise<void> {
  const client = serverConvexClient()
  let kind: "past" | "mock" = "past"
  try {
    const context = await client.query(api.exam.paperContext, { paperId })
    if (!context || context.status !== "processing" || context.runStartedAt !== runStartedAt)
      return
    kind = context.kind
    const unitIds = new Map(context.units.map((unit) => [unit.key, unit.unitId]))
    const units = context.units.map(({ key, title, concepts }) => ({ key, title, concepts }))
    let reply: string
    let hasSolutions = false
    if (context.kind === "past") {
      if (!context.paper?.text.trim())
        throw new ExamRunError(
          "No text could be read from this paper. Upload a PDF with selectable text, not a scan."
        )
      const solutions = context.solutions?.text.trim() ? context.solutions : undefined
      hasSolutions = Boolean(solutions)
      reply = await runExamTurn(
        buildPastPaperPrompt({
          moduleTitle: context.moduleTitle,
          paper: context.paper,
          ...(solutions ? { solutions } : {}),
          units,
        })
      )
    } else {
      if (!context.sources.length)
        throw new ExamRunError(
          "The chosen units have no readable material yet. Add material to them, then try again."
        )
      reply = await runExamTurn(
        buildMockExamPrompt({
          moduleTitle: context.moduleTitle,
          minutes: context.minutes ?? 60,
          units,
          sources: context.sources,
          weakConcepts: context.weakConcepts,
          examples: context.examples,
        })
      )
    }
    const parsed = parseExamPaper(reply, {
      kind: context.kind,
      unitKeys: [...unitIds.keys()],
      hasSolutions,
    })
    if (!parsed.questions.length)
      throw new ExamRunError(
        context.kind === "past"
          ? "No questions could be read from this paper. Try again."
          : "The mock exam came back without usable questions. Try again."
      )
    await client.mutation(api.exam.savePaper, {
      paperId,
      runStartedAt,
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(parsed.durationMinutes ? { durationMinutes: parsed.durationMinutes } : {}),
      ...(parsed.statedTotalMarks ? { statedTotalMarks: parsed.statedTotalMarks } : {}),
      questions: parsed.questions.map((question) => storedQuestion(question, unitIds)),
      rejectedCount: parsed.rejected,
    })
  } catch (error) {
    console.error("Exam paper could not be prepared", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    await client
      .mutation(api.exam.failPaper, {
        paperId,
        runStartedAt,
        error: failureMessage(
          error,
          kind === "past"
            ? "The paper could not be read. Try again."
            : "The mock exam could not be written. Try again."
        ),
      })
      .catch(() => undefined)
  }
}

/**
 * Marks every written answer of a submitted attempt in one provider turn
 * and saves the marks and feedback. Every answer must receive a valid grade,
 * otherwise the run fails and can be retried.
 * @param attemptId Submitted attempt.
 * @param gradingStartedAt Identifies this grading run.
 */
export async function runExamGrading(
  attemptId: Id<"examAttempts">,
  gradingStartedAt: number
): Promise<void> {
  const client = serverConvexClient()
  try {
    const context = await client.query(api.exam.gradingContext, { attemptId })
    if (!context) return
    let grades: Array<{ id: string; marks: number; feedback: string }> = []
    if (context.items.length) {
      const reply = await runExamTurn(
        buildExamGradingPrompt({
          moduleTitle: context.moduleTitle,
          paperTitle: context.paperTitle,
          items: context.items,
        })
      )
      const parsed = parseExamGrading(reply, context.items)
      if (parsed.missing.length)
        throw new ExamRunError("Some written answers could not be marked. Try again.")
      grades = parsed.grades
    }
    await client.mutation(api.exam.saveGrades, { attemptId, gradingStartedAt, grades })
  } catch (error) {
    console.error("Written answers could not be marked", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    await client
      .mutation(api.exam.failGrading, {
        attemptId,
        gradingStartedAt,
        error: failureMessage(error, "Written answers could not be marked. Try again."),
      })
      .catch(() => undefined)
  }
}

/** One answered choice question to record as study evidence. */
export type ExamEvidence = {
  questionId: string
  itemId: Id<"learningItems">
  type: "single-choice" | "multiple-answer" | "true-false"
  selectedOptionIds: string[]
}

/**
 * Records each answered choice question of a submitted attempt with
 * `learning.recordAnswerEvent`, so concept review, drills, and the feed learn
 * from exams. Event ids are stable per attempt and question, and the time is
 * the submission time, so recording again after a retry is a no-op. Failures
 * are logged and skipped; they never affect the attempt's marks.
 */
export async function recordExamEvidence(
  attemptId: Id<"examAttempts">,
  projectId: Id<"projects">,
  submittedAt: number,
  evidence: ExamEvidence[]
): Promise<void> {
  const client = serverConvexClient()
  for (const entry of evidence) {
    const [first] = entry.selectedOptionIds
    await client
      .mutation(api.learning.recordAnswerEvent, {
        clientEventId: `exam:${attemptId}:${entry.questionId}`,
        projectId,
        itemId: entry.itemId,
        occurredAt: submittedAt,
        answer:
          entry.type === "true-false"
            ? first === "true"
            : entry.type === "single-choice"
              ? first
              : entry.selectedOptionIds,
      })
      .catch((error: unknown) => {
        console.error("Exam answer could not be recorded", {
          message: error instanceof Error ? error.message : "Unknown error",
        })
      })
  }
}
