/** Keeps source page boundaries and normalizes known speech trouble spots. */

/** Maximum source characters in one audiobook narration edit request. */
export const AUDIOBOOK_SECTION_LENGTH = 6_000

/** One source slice, with a visible document boundary before it. */
export type AudiobookSection = {
  /** Text from one page, slide, or bounded continuation. */
  text: string
  /** Whether speech should pause before this page or slide. */
  startsNewSection: boolean
}

/** Splits a single page near paragraph or sentence boundaries without overlap. */
function splitPageText(text: string, maxLength: number): string[] {
  const sections: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLength) {
    const minimum = Math.floor(maxLength / 2)
    let boundary = remaining.lastIndexOf("\n\n", maxLength)
    if (boundary >= minimum) boundary += 2
    else {
      boundary = remaining.lastIndexOf(". ", maxLength)
      if (boundary >= minimum) boundary += 2
      else {
        boundary = remaining.lastIndexOf(" ", maxLength)
        if (boundary < minimum) boundary = maxLength
      }
    }
    // A hard cut must not separate the two code units of one character.
    if (
      /[\uD800-\uDBFF]/.test(remaining[boundary - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(remaining[boundary] ?? "")
    )
      boundary -= 1
    const section = remaining.slice(0, boundary).trim()
    if (section) sections.push(section)
    remaining = remaining.slice(boundary).trimStart()
  }
  if (remaining) sections.push(remaining)
  return sections
}

/** Retains page and slide boundaries while removing their spoken labels. */
export function splitAudiobookSource(
  text: string,
  maxLength = AUDIOBOOK_SECTION_LENGTH
): AudiobookSection[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 100)
    throw new Error("Audiobook section size is invalid")
  const sections: AudiobookSection[] = []
  let pageLines: string[] = []
  let isNewPage = false
  /** Flushes the current page, marking only its first bounded slice as a boundary. */
  function appendPage(): void {
    const page = pageLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    for (const [index, part] of splitPageText(page, maxLength).entries())
      sections.push({ text: part, startsNewSection: isNewPage && index === 0 })
    pageLines = []
  }
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\[(?:Page|Slide) \d+\]\s*$/i.test(line.trim())) {
      appendPage()
      isNewPage = true
    } else pageLines.push(line)
  }
  appendPage()
  return sections
}

/** Forces known abbreviations into forms the local voice reads consistently. */
export function spokenAudiobookText(text: string): string {
  return text
    .replace(/\bLLMs\b/g, "large language models")
    .replace(/\bLLM\b/g, "large language model")
    .replace(/\bAI\b/g, "A I")
    .replace(/\bML\b/g, "M L")
    .replace(/\bvs\.(?=\s+\w)/gi, "versus")
    .replace(/\bvs\b/gi, "versus")
    .replace(/\s+/g, " ")
    .trim()
}
