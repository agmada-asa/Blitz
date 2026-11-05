/**
 * Plain text rules for a passage quoted from a lesson into the side chat:
 * which sentence a position falls in, and how long a quote may be. Kept free
 * of the DOM so the rules can be tested; `lib/client/lesson-passage-dom.ts`
 * applies them to the rendered lesson.
 */

/** Most characters of a quoted passage, matching what a saved annotation accepts. */
export const MAX_PASSAGE_CHARACTERS = 4_000

/** Most characters of the surrounding lesson section sent with a question. */
export const MAX_LESSON_SECTION_CHARACTERS = 24_000

/** Message sent when the learner quotes a passage and asks nothing specific. */
export const EXPLAIN_PASSAGE_MESSAGE = "Explain this."

/** Label prefix of the lesson section attached to a side chat turn. */
export const LESSON_SECTION_LABEL_PREFIX = "Lesson section: "

/**
 * Finds the sentence around one position in a block of text.
 *
 * @param text The block's text.
 * @param offset A character position; values outside the text are clamped.
 * @returns The sentence's start and end, excluding surrounding whitespace.
 */
export function sentenceBoundsAt(
  text: string,
  offset: number
): { start: number; end: number } {
  const position = Math.max(0, Math.min(offset, Math.max(0, text.length - 1)))
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" })
  let start = 0
  let end = text.length
  for (const part of segmenter.segment(text)) {
    const partEnd = part.index + part.segment.length
    if (position < partEnd) {
      start = part.index
      end = partEnd
      break
    }
  }
  // Whitespace between sentences belongs to neither of them.
  while (start < end && /\s/.test(text[start])) start += 1
  while (end > start && /\s/.test(text[end - 1])) end -= 1
  return { start, end }
}

/**
 * Tidies captured lesson text for quoting: collapses runs of spaces and blank
 * lines, and cuts anything too long to save with a trailing ellipsis.
 *
 * @param text Text captured from the lesson.
 * @returns The quote, which is empty when the text held nothing readable.
 */
export function normalizePassage(text: string): string {
  const tidy = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
  return tidy.length > MAX_PASSAGE_CHARACTERS
    ? `${tidy.slice(0, MAX_PASSAGE_CHARACTERS - 1).trimEnd()}…`
    : tidy
}
