/** Interprets spoken quiz controls and unambiguous option labels without guessing answers. */
import type { QuizType } from "./interactive-blocks.ts"

/** Returns a spoken control command, an option index, or null when the learner should retry. */
export function spokenQuizAnswer(text: string, options: readonly { text: string }[]): number | "next" | "repeat" | "skip" | null {
  const words = text.toLowerCase().replace(/[.!?,]/g, "").trim()
  if (/^(next|next question)$/.test(words)) return "next"
  if (/^(repeat|say (that|it) again)$/.test(words)) return "repeat"
  if (/^(skip|i don'?t know|not sure)$/.test(words)) return "skip"
  const numbers = ["one", "two", "three", "four", "five", "six"]
  const candidates = options.flatMap((option, index) => {
    const letter = String.fromCharCode(97 + index)
    return [letter, String(index + 1), numbers[index], option.text.toLowerCase().replace(/[.!?,]/g, "").trim()].some(value =>
      words === value || words === "option " + value || words === "the answer is " + value
    ) ? [index] : []
  })
  return candidates.length === 1 ? candidates[0] : null
}

/** The parts of a drill question a spoken turn needs. */
export type SpokenDrillQuestion = {
  type: QuizType
  options: readonly { id: string; text: string }[]
  acceptedAnswers?: readonly (readonly string[])[]
}

/**
 * What a spoken drill turn asks the drill to do. `skip` reveals the answer without scoring it,
 * `remind` and `retry` re-prompt the learner, and only `submit` sends an answer for scoring.
 */
export type DrillVoiceAction =
  | { type: "repeat" } | { type: "next" } | { type: "skip" } | { type: "remind" } | { type: "retry" }
  | { type: "submit"; selectedOptionIds: string[] }

/**
 * Maps one spoken drill turn to an action. Skip never becomes a submitted answer, because an empty
 * answer is not a neutral value for every format (a true-false serializer would read it as false).
 * @param answered Whether the current question already has a result.
 */
export function drillVoiceAction(text: string, question: SpokenDrillQuestion, answered: boolean): DrillVoiceAction {
  const answer = spokenQuizAnswer(text, question.options)
  if (answer === "repeat") return { type: "repeat" }
  if (answer === "next" && answered) return { type: "next" }
  // Skipping an answered question just repeats its feedback.
  if (answer === "skip") return { type: answered ? "repeat" : "skip" }
  if (answered) return { type: "remind" }
  // Short typed formats take the spoken words as the answer.
  if (question.type === "code-output" || (question.type === "cloze" && question.acceptedAnswers?.length === 1))
    return { type: "submit", selectedOptionIds: [text] }
  if (typeof answer !== "number" || (question.type !== "single-choice" && question.type !== "true-false"))
    return { type: "retry" }
  return { type: "submit", selectedOptionIds: [question.options[answer].id] }
}

/**
 * Converts selected option ids into the answer the learning endpoint scores for a question type.
 * @returns Undefined when nothing (or no true-false option) was selected, so a missing answer is never
 * sent as false or as an empty list.
 */
export function drillAnswerValue(type: QuizType, selectedOptionIds: readonly string[]): boolean | string | string[] | undefined {
  const [first] = selectedOptionIds
  if (first === undefined) return undefined
  if (type === "true-false") return first === "true" ? true : first === "false" ? false : undefined
  if (type === "single-choice") return first
  return [...selectedOptionIds]
}
