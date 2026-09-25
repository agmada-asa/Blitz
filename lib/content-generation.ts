/** Defines the bounded agent draft contract shared by the worker and Convex. */

import { z } from "zod"

/** Visible lesson depth; three is the default two-paragraph treatment. */
export const DEFAULT_CONTENT_DEPTH = 3

/** Labels and upper word limits for the five content depth positions. */
export const CONTENT_DEPTHS = [
  { value: 1, label: "Compact", maxWords: 90 },
  { value: 2, label: "Brief", maxWords: 120 },
  { value: 3, label: "Balanced", maxWords: 180 },
  { value: 4, label: "Detailed", maxWords: 250 },
  { value: 5, label: "In depth", maxWords: 330 },
] as const

/** Returns the requested depth or rejects a malformed persisted value. */
export function contentDepth(value: number) {
  const option = CONTENT_DEPTHS.find((candidate) => candidate.value === value)
  if (!option) throw new Error("Choose a content depth from 1 to 5")
  return option
}

/** One exact source location supporting a lesson or new question. */
const sourceReferenceSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    locator: z.string().trim().min(1).max(180),
  })
  .strict()

/** A choice option whose stable ID is used for server-owned scoring. */
const optionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    text: z.string().trim().min(1).max(300),
  })
  .strict()

/** Questions remain structured controls beside Markdown lesson content. */
const questionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("single-choice"),
      question: z.string().trim().min(1).max(500),
      feedback: z.string().trim().min(1).max(800),
      options: z.array(optionSchema).min(2).max(8),
      correctOptionId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("multiple-answer"),
      question: z.string().trim().min(1).max(500),
      feedback: z.string().trim().min(1).max(800),
      options: z.array(optionSchema).min(3).max(8),
      correctOptionIds: z.array(z.string().trim().min(1).max(64)).min(2).max(7),
    })
    .strict(),
  z
    .object({
      type: z.literal("true-false"),
      question: z.string().trim().min(1).max(500),
      feedback: z.string().trim().min(1).max(800),
      correctAnswer: z.boolean(),
    })
    .strict(),
])

/** One agent-authored lesson and any genuinely new check questions. */
export const lessonDraftSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    conceptId: z.string().min(1).max(128).optional(),
    topicTitle: z.string().trim().min(1).max(140),
    conceptTitle: z.string().trim().min(1).max(180),
    title: z.string().trim().min(1).max(180),
    bodyMarkdown: z.string().trim().min(1).max(6_000),
    sourceReferences: z.array(sourceReferenceSchema).min(1).max(12),
    questions: z.array(questionSchema).max(4),
    retireQuestionIds: z.array(z.string().min(1).max(128)).max(12).optional(),
  })
  .strict()

/** The bounded file list emitted after an agent has reviewed the new source. */
export const contentManifestSchema = z
  .object({
    version: z.literal(1),
    sourceId: z.string().min(1).max(128),
    pages: z
      .array(z.string().regex(/^pages\/[a-z0-9][a-z0-9_-]{0,79}\.json$/))
      .max(250),
    /** One decision for every extracted section, or agent-identified section when extraction is unavailable. */
    coverage: z
      .array(
        z
          .object({
            sectionId: z.string().trim().min(1).max(180),
            status: z.enum(["included", "skipped"]),
            pageKeys: z
              .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/))
              .max(20),
            reason: z.string().trim().min(1).max(300).optional(),
          })
          .strict()
      )
      .min(1)
      .max(1_000),
    skippedReason: z.string().trim().min(1).max(400).optional(),
  })
  .strict()

/** A validated draft accepted for project learning persistence. */
export type LessonDraft = z.infer<typeof lessonDraftSchema>

/** A validated manifest of agent-written lesson files. */
export type ContentManifest = z.infer<typeof contentManifestSchema>

/** Checks page length, answer IDs, and source ownership using one source inventory. */
export function validateLessonDraft(
  value: unknown,
  depth: number,
  knownSourceIds: ReadonlySet<string>,
  newSourceId: string
): LessonDraft {
  const page = lessonDraftSchema.parse(value)
  if (
    !page.sourceReferences.some(
      (reference) => reference.sourceId === newSourceId
    )
  )
    throw new Error(`Page ${page.key} must reference the new source`)
  if (
    page.sourceReferences.some(
      (reference) => !knownSourceIds.has(reference.sourceId)
    )
  )
    throw new Error(`Page ${page.key} references an unknown source`)
  if (
    page.retireQuestionIds &&
    new Set(page.retireQuestionIds).size !== page.retireQuestionIds.length
  )
    throw new Error(`Page ${page.key} repeats a retired question`)
  const words = page.bodyMarkdown.match(/\S+/g)?.length ?? 0
  if (words > contentDepth(depth).maxWords)
    throw new Error(`Page ${page.key} exceeds the selected depth`)
  for (const question of page.questions) {
    if (question.type === "true-false") continue
    const ids = question.options.map((option) => option.id)
    if (new Set(ids).size !== ids.length)
      throw new Error(`Page ${page.key} has repeated answer IDs`)
    if (question.type === "single-choice") {
      if (!ids.includes(question.correctOptionId))
        throw new Error(`Page ${page.key} has an unknown correct answer`)
    } else if (
      new Set(question.correctOptionIds).size !==
        question.correctOptionIds.length ||
      question.correctOptionIds.length >= ids.length ||
      question.correctOptionIds.some((id) => !ids.includes(id))
    ) {
      throw new Error(`Page ${page.key} has invalid correct answers`)
    }
  }
  return page
}
