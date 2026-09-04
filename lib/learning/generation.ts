/** Defines portable validation for one bounded, source-attributed learning batch. */

import { z } from "zod"

/** Maximum concepts a single source chunk may produce. */
export const MAX_CONCEPTS_PER_CHUNK = 8

/** Maximum learning items a single source chunk may produce. */
export const MAX_ITEMS_PER_CHUNK = 16

/** Maximum lengths accepted for generated learning fields. */
export const LEARNING_GENERATION_LIMITS = {
  summary: 1_000,
  title: 180,
  topicTitle: 140,
  body: 4_000,
  question: 500,
  option: 300,
  key: 64,
} as const

/** A stable option shared by choice learning items and Convex persistence. */
export type LearningOption = {
  id: string
  text: string
}

/** Supported generated item formats for the learning model. */
export type GeneratedLearningItemType =
  "explain" | "single-choice" | "multiple-answer" | "true-false"

/** One validated generated concept, inferred from the current source chunk. */
export type GeneratedConcept = {
  key: string
  title: string
  topicTitle: string
}

/** One validated item that can be mapped to a persisted concept and source. */
export type GeneratedLearningItem = {
  conceptKey: string
  type: GeneratedLearningItemType
  title: string
  body: string
  question?: string
  options?: LearningOption[]
  correctOptionId?: string
  correctOptionIds?: string[]
  correctAnswer?: boolean
  sourceChunkIds: [string]
}

/** The bounded, source-attributed output returned for one chunk checkpoint. */
export type LearningGenerationBatch = {
  summary: string
  concepts: GeneratedConcept[]
  items: GeneratedLearningItem[]
}

/** Requires a trimmed non-empty bounded string in generated output. */
const boundedString = (maximum: number) => z.string().trim().min(1).max(maximum)

/** Validates a safe concept key that can be used as a batch-local join key. */
const conceptKey = z
  .string()
  .trim()
  .min(1)
  .max(LEARNING_GENERATION_LIMITS.key)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

/** Validates one generated choice option. */
const optionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    text: boundedString(LEARNING_GENERATION_LIMITS.option),
  })
  .strict()

/** Shared fields required by every generated learning item. */
const commonItemSchema = {
  conceptKey,
  title: boundedString(LEARNING_GENERATION_LIMITS.title),
  body: boundedString(LEARNING_GENERATION_LIMITS.body),
  sourceChunkIds: z.array(z.string().trim().min(1)).length(1),
}

/** Validates a concept explanation without question or answer fields. */
const explainItemSchema = z
  .object({
    ...commonItemSchema,
    type: z.literal("explain"),
  })
  .strict()

/** Validates a single-choice question and its one correct option. */
const singleChoiceItemSchema = z
  .object({
    ...commonItemSchema,
    type: z.literal("single-choice"),
    question: boundedString(LEARNING_GENERATION_LIMITS.question),
    options: z.array(optionSchema).min(2).max(8),
    correctOptionId: z.string().trim().min(1).max(64),
  })
  .strict()

/** Validates a multiple-answer question and its exact correct option set. */
const multipleAnswerItemSchema = z
  .object({
    ...commonItemSchema,
    type: z.literal("multiple-answer"),
    question: boundedString(LEARNING_GENERATION_LIMITS.question),
    options: z.array(optionSchema).min(3).max(8),
    correctOptionIds: z.array(z.string().trim().min(1).max(64)).min(2).max(7),
  })
  .strict()

/** Validates a true-false question with a server-owned boolean answer. */
const trueFalseItemSchema = z
  .object({
    ...commonItemSchema,
    type: z.literal("true-false"),
    question: boundedString(LEARNING_GENERATION_LIMITS.question),
    correctAnswer: z.boolean(),
  })
  .strict()

/** Validates the discriminated item formats before cross-reference checks. */
const itemSchema = z.discriminatedUnion("type", [
  explainItemSchema,
  singleChoiceItemSchema,
  multipleAnswerItemSchema,
  trueFalseItemSchema,
])

/** Strict Zod schema shared by server generation and Convex persistence gates. */
export const learningGenerationSchema = z
  .object({
    summary: boundedString(LEARNING_GENERATION_LIMITS.summary),
    concepts: z
      .array(
        z
          .object({
            key: conceptKey,
            title: boundedString(LEARNING_GENERATION_LIMITS.title),
            topicTitle: boundedString(LEARNING_GENERATION_LIMITS.topicTitle),
          })
          .strict()
      )
      .min(0)
      .max(MAX_CONCEPTS_PER_CHUNK),
    items: z.array(itemSchema).min(0).max(MAX_ITEMS_PER_CHUNK),
  })
  .strict()

/** Error raised when a parsed batch fails cross-reference or answer checks. */
export class LearningGenerationValidationError extends Error {
  /** Creates a portable validation error without retaining source contents. */
  constructor(message: string) {
    super(message)
    this.name = "LearningGenerationValidationError"
  }
}

/** Validates option IDs and answer references for one choice item. */
function validateChoiceAnswers(
  item: GeneratedLearningItem,
  issues: string[]
): void {
  if (!item.options) {
    issues.push(`${item.type} item must include options`)
    return
  }
  const optionIds = item.options.map((option) => option.id)
  if (new Set(optionIds).size !== optionIds.length) {
    issues.push(`${item.type} item options must have unique IDs`)
  }
  const knownOptionIds = new Set(optionIds)
  if (item.type === "single-choice") {
    if (!knownOptionIds.has(item.correctOptionId ?? "")) {
      issues.push("single-choice item must reference one provided option")
    }
    return
  }
  const answerIds = item.correctOptionIds ?? []
  if (new Set(answerIds).size !== answerIds.length) {
    issues.push("multiple-answer item answers must be unique")
  }
  if (answerIds.some((id) => !knownOptionIds.has(id))) {
    issues.push("multiple-answer item must reference only provided options")
  }
  if (answerIds.length < 2 || answerIds.length >= optionIds.length) {
    issues.push(
      "multiple-answer item must have more than one but fewer than all correct options"
    )
  }
}

/** Checks batch-local joins and source provenance against one current chunk ID. */
function validateBatchReferences(
  batch: LearningGenerationBatch,
  sourceChunkId: string
): string[] {
  const issues: string[] = []
  const conceptKeys = new Set<string>()
  for (const concept of batch.concepts) {
    if (conceptKeys.has(concept.key)) {
      issues.push(`duplicate concept key: ${concept.key}`)
    }
    conceptKeys.add(concept.key)
  }
  const usedConceptKeys = new Set<string>()
  for (const item of batch.items) {
    if (!conceptKeys.has(item.conceptKey)) {
      issues.push(`unknown concept key: ${item.conceptKey}`)
    }
    usedConceptKeys.add(item.conceptKey)
    if (
      item.sourceChunkIds.length !== 1 ||
      item.sourceChunkIds[0] !== sourceChunkId
    ) {
      issues.push(
        `item ${item.title} references a chunk other than ${sourceChunkId}`
      )
    }
    if (item.type === "single-choice" || item.type === "multiple-answer") {
      validateChoiceAnswers(item, issues)
    }
  }
  for (const concept of batch.concepts) {
    if (!usedConceptKeys.has(concept.key)) {
      issues.push(`concept has no learning item: ${concept.key}`)
    }
  }
  return issues
}

/** Parses and validates an unknown value against one current chunk ID. */
export function validateLearningGeneration(
  value: unknown,
  sourceChunkId: string
): LearningGenerationBatch {
  const parsed = learningGenerationSchema.safeParse(value)
  if (!parsed.success) {
    throw new LearningGenerationValidationError(
      `Generated learning batch failed schema validation: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    )
  }
  const batch = parsed.data as LearningGenerationBatch
  const isSkipped = batch.concepts.length === 0 && batch.items.length === 0
  if (isSkipped && !/^skipped:/i.test(batch.summary)) {
    throw new LearningGenerationValidationError(
      "Skipped learning batches must explain the reason in summary with a SKIPPED: prefix"
    )
  }
  if (!isSkipped && (batch.concepts.length === 0 || batch.items.length === 0)) {
    throw new LearningGenerationValidationError(
      "Learning batches must contain concepts and items together"
    )
  }
  const issues = validateBatchReferences(batch, sourceChunkId)
  if (issues.length) {
    throw new LearningGenerationValidationError(
      `Generated learning batch contains invalid references: ${issues.join("; ")}`
    )
  }
  return batch
}
