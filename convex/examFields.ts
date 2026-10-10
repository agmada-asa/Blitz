/**
 * Shares exam mode's persisted validators between the schema and the exam
 * functions in `convex/exam.ts`, so a saved paper, an autosaved answer, and a
 * marking result always have the same shape.
 */
import { v } from "convex/values"

/** Question formats an exam paper can hold. */
export const examQuestionType = v.union(
  v.literal("single-choice"),
  v.literal("multiple-answer"),
  v.literal("true-false"),
  v.literal("written")
)

/**
 * One question on a paper. Choice questions carry options, the correct
 * option ids, an explanation, and the learning item their answers are
 * recorded against. Written questions carry a model answer and a mark scheme.
 */
export const examQuestionFields = v.object({
  /** Unique within the paper: q1, q2, … in paper order. */
  id: v.string(),
  /** Label printed on the paper, such as "3" or "2b". */
  number: v.string(),
  marks: v.number(),
  type: examQuestionType,
  /** Markdown; may hold code blocks and LaTeX. */
  prompt: v.string(),
  options: v.optional(v.array(v.object({ id: v.string(), text: v.string() }))),
  correctOptionIds: v.optional(v.array(v.string())),
  explanation: v.optional(v.string()),
  modelAnswer: v.optional(v.string()),
  markScheme: v.optional(v.array(v.object({ point: v.string(), marks: v.number() }))),
  /** Past papers only: whether the answer came from uploaded solutions. */
  answerSource: v.optional(v.union(v.literal("solutions"), v.literal("inferred"))),
  concept: v.string(),
  /** Unit whose material the question tests, when one matched. */
  unitId: v.optional(v.id("units")),
  /** Learning item that records answers to a choice question as study evidence. */
  itemId: v.optional(v.id("learningItems")),
})

/** The learner's answer to one question, autosaved while the paper is open. */
export const examAnswerFields = v.object({
  questionId: v.string(),
  selectedOptionIds: v.optional(v.array(v.string())),
  text: v.optional(v.string()),
})

/** How one question was marked. `awardedMarks` is unset while a written answer waits for marking. */
export const examResultFields = v.object({
  questionId: v.string(),
  outcome: v.union(
    v.literal("unanswered"),
    v.literal("correct"),
    v.literal("incorrect"),
    v.literal("pending"),
    v.literal("marked")
  ),
  awardedMarks: v.optional(v.number()),
  feedback: v.optional(v.string()),
})
