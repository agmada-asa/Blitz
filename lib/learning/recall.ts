/**
 * Decides which Review questions are asked from memory first. Answering
 * before seeing options (retrieval) builds stronger memories than picking
 * from a list (recognition), so about half the single-choice questions that
 * make sense without their options start as recall: the learner answers in
 * their head, reveals the answer, and grades themselves.
 */

/** Phrases that only make sense with the options in view. */
const NEEDS_OPTIONS =
  /\b(which of (the|these)|which (one|statement|option|answer|choice)s?\b|of the following|select|all that apply|true or false|none of|all of the above|best describes)\b/i

/**
 * Returns whether a question can be answered from memory before its options
 * are shown: single-choice, and not worded around the options.
 */
export function canRecallFromMemory(card: { type: string; question?: string }): boolean {
  if (card.type !== "single-choice" || !card.question?.trim()) return false
  if (card.question.includes("```")) return false
  return !NEEDS_OPTIONS.test(card.question)
}

/**
 * Picks recall for about half the eligible questions, stably per question so a
 * reload shows the same mode.
 * @param id The learning item's id.
 */
export function startsAsRecall(card: { id: string; type: string; question?: string }): boolean {
  if (!canRecallFromMemory(card)) return false
  let hash = 0
  for (const character of card.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % 2 === 0
}
