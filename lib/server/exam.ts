/**
 * Runs exam mode's background provider work: extracting a past paper's
 * questions, writing a mock paper, and marking an attempt's written answers.
 *
 * Each job is one provider turn in a temporary read-only directory, started
 * by an API route with `after()` so the request returns at once. Runs are
 * tracked in Convex (`convex/exam.ts`), which the Practice and exam screens
 * follow live. A run never throws: failures are saved with a learner-facing
 * message so the screen can offer a retry.
 *
 * A past paper goes to Claude Code as the original document, so scans,
 * figures and equations come through; Codex gets the extracted text, or the
 * file itself when a scan has none; OpenCode gets the text. When a document
 * read fails quickly, the run tries once more with the extracted text.
 */

import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"

import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"
import { resolveAiTaskSelection, type AiProviderId } from "../ai-model-settings.ts"
import {
  buildExamGradingPrompt,
  buildMockExamPrompt,
  buildPastPaperPrompt,
  EXAM_GRADING_SCHEMA,
  examPaperSchema,
  parseExamGrading,
  parseExamPaper,
  type ExamQuestion,
  type ExamUnitOption,
  type PastPaperSource,
} from "../exam.ts"
import type { JsonSchema } from "../json-schema.ts"
import type { ModelReply } from "../practice.ts"
import { loadSavedAiModelSettings } from "./ai-model-settings.ts"
import { CardChatError } from "./card-chat.ts"
import { serverConvexClient } from "./convex.ts"
import { resolveProjectFile } from "./project-files.ts"
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

/** A paper or solutions file as `exam.paperContext` returns it. */
type PaperDocument = {
  filename: string
  text: string
  file?: { relativeKey: string; kind: string; mimeType?: string; sizeBytes?: number }
}

/** What one exam turn sends: its prompt, and any files the model reads as documents. */
type ExamTurnInput = { prompt: string; files?: { path: string; name: string }[] }

/**
 * Largest original file sent as a document. Claude's requests stop at 32 MB
 * and a file travels base64 encoded, a third larger, so 20 MB leaves room for
 * the prompt. A larger paper falls back to its extracted text.
 */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

/**
 * A failed document read is retried with the extracted text only when it
 * failed this quickly, so a retry cannot run past the ten-minute run lease.
 */
const DOCUMENT_RETRY_WINDOW_MS = 90_000

/**
 * Sends one turn to the provider chosen for question writing and returns
 * the reply. The provider works in an empty temporary directory with a
 * read-only sandbox and no web search, so it only sees the prompt and any
 * files `build` places there or attaches.
 * @param outputSchema Reply shape Codex and Claude Code must follow.
 * @param build Writes the turn for the chosen provider and its temporary folder.
 * @returns The reply text, with the provider's parsed object when it has one.
 */
async function runExamTurn(
  outputSchema: JsonSchema,
  build: (turn: { providerId: AiProviderId; directory: string }) => Promise<ExamTurnInput>
): Promise<ModelReply> {
  const client = serverConvexClient()
  const directory = await mkdtemp(join(tmpdir(), "blitz-exam-"))
  try {
    const settings = await loadSavedAiModelSettings(client)
    const selection = resolveAiTaskSelection(settings, "cardGeneration", {
      providerEnvironmentFallback: process.env.BLITZ_REPLY_PROVIDER,
      modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
      effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
    })
    const turn = await build({ providerId: selection.providerId, directory })
    const result = await runProviderTextTurn({
      providerId: selection.providerId,
      model: selection.model,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      workspaceDirectory: directory,
      prompt: turn.prompt,
      ...(turn.files?.length ? { files: turn.files } : {}),
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: TURN_TIMEOUT_MS,
      outputSchema,
    })
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Decides how one past paper document reaches the provider. Claude Code
 * reads PDFs and text files as documents, page images included, so it gets
 * the original file whenever one is stored and small enough. Codex is only
 * told a file's path and reads it with its own tools, so it keeps the
 * extracted text and gets the file only for a scan with no text. OpenCode
 * takes no files, so it always gets the text.
 * @param providerId Provider writing the questions.
 * @param document The paper or solutions.
 * @param textOnly Whether a document read already failed and text is wanted.
 * @returns How to send it, or undefined when this provider cannot read it.
 */
export function pastPaperDelivery(
  providerId: AiProviderId,
  document: PaperDocument,
  textOnly = false
): "text" | "document" | "file" | undefined {
  const hasText = Boolean(document.text.trim())
  const file = document.file
  const readable =
    !textOnly &&
    file !== undefined &&
    ["pdf", "markdown", "text"].includes(file.kind) &&
    (file.sizeBytes ?? 0) <= MAX_DOCUMENT_BYTES
  if (providerId === "claude-code" && readable) return "document"
  if (hasText) return "text"
  if (providerId === "codex" && readable && file.kind === "pdf") return "file"
  return undefined
}

/**
 * Builds a past paper turn for one provider: the prompt, with each document
 * as text, an attached document, or a copy in the turn's folder.
 * @returns The turn, and whether the paper was read from a scan.
 */
async function pastPaperTurn(
  context: { projectId: string; moduleTitle: string; units: ExamUnitOption[] },
  paper: PaperDocument,
  solutions: PaperDocument | undefined,
  turn: { providerId: AiProviderId; directory: string },
  textOnly: boolean
): Promise<ExamTurnInput & { fromScan: boolean }> {
  const files: { path: string; name: string }[] = []
  /** Prepares one document for the prompt, copying or attaching its file. */
  const prepare = async (
    document: PaperDocument,
    delivery: "text" | "document" | "file",
    copyName: string
  ): Promise<PastPaperSource> => {
    if (delivery === "text" || !document.file) return { ...document, delivery: { kind: "text" } }
    const path = await resolveProjectFile(context.projectId, document.file.relativeKey)
    if (delivery === "document") {
      files.push({ path, name: document.filename })
      return { ...document, delivery: { kind: "document" } }
    }
    const name = `${copyName}${extname(document.filename).toLowerCase() || ".pdf"}`
    await copyFile(path, join(turn.directory, name))
    return { ...document, delivery: { kind: "file", path: name } }
  }
  const paperDelivery = pastPaperDelivery(turn.providerId, paper, textOnly)
  if (!paperDelivery)
    throw new ExamRunError(
      paper.file?.kind === "pdf"
        ? "No text could be read from this paper. Upload a PDF with selectable text, or choose Claude Code or Codex for question writing in Settings to read scans."
        : "No text could be read from this paper. Upload a PDF with selectable text, not a scan."
    )
  const solutionsDelivery = solutions
    ? pastPaperDelivery(turn.providerId, solutions, textOnly)
    : undefined
  const prompt = buildPastPaperPrompt({
    moduleTitle: context.moduleTitle,
    paper: await prepare(paper, paperDelivery, "paper"),
    ...(solutions && solutionsDelivery
      ? { solutions: await prepare(solutions, solutionsDelivery, "solutions") }
      : {}),
    units: context.units,
  })
  return {
    prompt,
    ...(files.length ? { files } : {}),
    fromScan: paperDelivery !== "text" && !paper.text.trim(),
  }
}

/** Returns a short learner-facing reason for a failed run. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ExamRunError) return error.message
  if (error instanceof CardChatError && error.reason === "spend-limit") return error.message
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
    let reply: ModelReply
    let hasSolutions = false
    let readFromScan = false
    if (context.kind === "past") {
      const paper = context.paper
      if (!paper)
        throw new ExamRunError("This paper's file is missing. Delete it and add it again.")
      const solutions =
        context.solutions && (context.solutions.text.trim() || context.solutions.file)
          ? context.solutions
          : undefined
      /** Runs the extraction turn, with documents attached unless `textOnly`. */
      const extract = (textOnly: boolean) =>
        runExamTurn(examPaperSchema("past"), async (turn) => {
          const prepared = await pastPaperTurn(
            { projectId: context.projectId, moduleTitle: context.moduleTitle, units },
            paper,
            solutions,
            turn,
            textOnly
          )
          readFromScan = prepared.fromScan
          // Solutions count only when this provider could be sent them.
          hasSolutions = Boolean(
            solutions && pastPaperDelivery(turn.providerId, solutions, textOnly)
          )
          return prepared
        })
      const startedAt = Date.now()
      try {
        reply = await extract(false)
      } catch (error) {
        // A document the provider could not take falls back to the extracted
        // text, when there is some and the first try failed fast enough.
        const retryable =
          error instanceof CardChatError &&
          ["turn-failed", "transport", "invalid-input"].includes(error.reason) &&
          Date.now() - startedAt < DOCUMENT_RETRY_WINDOW_MS
        if (!retryable || !paper.text.trim() || !paper.file) throw error
        reply = await extract(true)
      }
    } else {
      if (!context.sources.length)
        throw new ExamRunError(
          "The chosen units have no readable material yet. Add material to them, then try again."
        )
      reply = await runExamTurn(examPaperSchema("mock"), async () => ({
        prompt: buildMockExamPrompt({
          moduleTitle: context.moduleTitle,
          minutes: context.minutes ?? 60,
          ...(context.generationGuidance
            ? { generationGuidance: context.generationGuidance }
            : {}),
          units,
          sources: context.sources,
          weakConcepts: context.weakConcepts,
          examples: context.examples,
        }),
      }))
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
      ...(readFromScan ? { readFromScan: true } : {}),
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
      const reply = await runExamTurn(EXAM_GRADING_SCHEMA, async () => ({
        prompt: buildExamGradingPrompt({
          moduleTitle: context.moduleTitle,
          paperTitle: context.paperTitle,
          items: context.items,
        }),
      }))
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
