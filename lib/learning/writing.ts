/** Defines the small deterministic state transition used by written practice. */

/** Persisted answer state for one written prompt. */
export interface WrittenAnswerState {
  /** Current learner answer, if a draft has been saved. */
  readonly answer?: string
  /** Whether the source reference has been revealed. */
  readonly revealed: boolean
  /** Source-backed reference retained in the server snapshot. */
  readonly reference: string
}

/** Applies a draft save or one-way comparison reveal to an answer state. */
export function applyWrittenAnswer(
  current: WrittenAnswerState,
  answer: string,
  reveal: boolean
): WrittenAnswerState {
  const trimmed = answer.trim()
  if (!trimmed) throw new Error("Answer is required")
  if (trimmed.length > 10_000) throw new Error("Answer is too long")
  if (current.revealed && current.answer !== trimmed)
    throw new Error("Revealed answers cannot be changed")
  return {
    answer: current.revealed ? current.answer : trimmed,
    revealed: current.revealed || reveal,
    reference: current.reference,
  }
}
