/**
 * Shares the validated quiz shape and its mapping onto learning items between
 * the functions that save quizzes as questions: generated question banks
 * (`convex/practice.ts`), lesson quizzes (`convex/teach.ts`), and quizzes
 * saved from chat. Keeping one mapping means every question format is stored
 * and scored the same way wherever it was written.
 */
import { v, type Infer } from "convex/values"

import type { Doc } from "./_generated/dataModel"

/** Every quiz format a learning item can hold. */
export const quizType = v.union(
  v.literal("single-choice"),
  v.literal("multiple-answer"),
  v.literal("true-false"),
  v.literal("cloze"),
  v.literal("ordering"),
  v.literal("matching"),
  v.literal("code-output")
)

/**
 * A quiz already validated by `parseInteractiveBlock` in `lib/interactive-blocks.ts`.
 * Server routes send it after parsing; `quizItemFields` re-checks the parts
 * that would make the stored item unanswerable.
 */
export const quizFields = {
  concept: v.string(),
  type: quizType,
  question: v.string(),
  options: v.array(v.object({ id: v.string(), text: v.string() })),
  correctOptionIds: v.array(v.string()),
  /** Matching only. */
  prompts: v.optional(v.array(v.string())),
  /** Cloze and code output only. */
  acceptedAnswers: v.optional(v.array(v.array(v.string()))),
  explanation: v.string(),
}

/** Validator for one parsed quiz. */
export const quizValidator = v.object(quizFields)

/** A parsed quiz as accepted by the mutations that save questions. */
export type QuizInput = Infer<typeof quizValidator>

/** The answer-key fields of a learning item, written from a quiz. */
type QuizItemFields = Pick<
  Doc<"learningItems">,
  | "type"
  | "question"
  | "body"
  | "options"
  | "correctOptionId"
  | "correctOptionIds"
  | "correctAnswer"
  | "matchPrompts"
  | "acceptedAnswers"
>

/**
 * Maps a quiz to the learning-item fields that store its prompt and answer
 * key, so `learning.recordAnswerEvent` can score it.
 * @param quiz A parsed quiz.
 * @returns Fields to spread into a `learningItems` insert.
 * @throws When the quiz is missing the key its format needs.
 */
export function quizItemFields(quiz: QuizInput): QuizItemFields {
  const base = {
    type: quiz.type,
    question: quiz.question.slice(0, 2_000),
    body: quiz.explanation.slice(0, 4_000),
  }
  const correct = quiz.correctOptionIds
  switch (quiz.type) {
    case "true-false":
      return { ...base, correctAnswer: correct[0] === "true" }
    case "single-choice":
      if (!correct[0]) throw new Error("Question has no correct option")
      return { ...base, options: quiz.options, correctOptionId: correct[0] }
    case "multiple-answer":
    case "ordering":
      if (!correct.length) throw new Error("Question has no answer key")
      return { ...base, options: quiz.options, correctOptionIds: correct }
    case "matching":
      if (!quiz.prompts?.length || quiz.prompts.length !== correct.length)
        throw new Error("Matching question has no pairs")
      return {
        ...base,
        options: quiz.options,
        correctOptionIds: correct,
        matchPrompts: quiz.prompts,
      }
    case "cloze":
    case "code-output":
      if (!quiz.acceptedAnswers?.length || quiz.acceptedAnswers.some((entry) => !entry.length))
        throw new Error("Question has no accepted answers")
      return { ...base, acceptedAnswers: quiz.acceptedAnswers }
  }
}

/**
 * Shapes a stored question for the quiz renderer, including its answer key.
 * Inverse of `quizItemFields`.
 * @param item A question learning item (not an explain item).
 * @returns The fields of a `QuizBlock` other than `kind` and `id`.
 */
export function quizFromItem(item: Doc<"learningItems">) {
  const type = item.type === "explain" ? "single-choice" : item.type
  const options =
    type === "true-false"
      ? [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ]
      : (item.options ?? [])
  const correctOptionIds =
    type === "true-false"
      ? [String(item.correctAnswer ?? false)]
      : type === "single-choice"
        ? item.correctOptionId
          ? [item.correctOptionId]
          : []
        : (item.correctOptionIds ?? [])
  return {
    concept: item.title,
    type,
    question: item.question ?? "",
    options,
    correctOptionIds,
    ...(item.matchPrompts ? { prompts: item.matchPrompts } : {}),
    ...(item.acceptedAnswers ? { acceptedAnswers: item.acceptedAnswers } : {}),
    explanation: item.body,
  }
}
