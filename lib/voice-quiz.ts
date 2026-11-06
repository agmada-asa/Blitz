/** Interprets spoken quiz controls and unambiguous option labels without guessing answers. */

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
