/** Splits read aloud text into a quick opening and bounded playback sections. */

/** Maximum opening size, shared by preparation and foreground playback. */
export const SPEECH_OPENING_CHARS = 120
/** Later sections provide enough audio to cover synthesis of the following section. */
export const SPEECH_SECTION_CHARS = 360
/** Keep the second section small enough to synthesize during the short opening. */
const SPEECH_SECOND_SECTION_CHARS = 120

/** Finds a natural boundary within the limit without cutting a Unicode character. */
function speechBoundary(text: string, limit: number): number {
  const prefix = text.slice(0, limit)
  const boundaries = [...prefix.matchAll(/[.!?;:]\s+|\n+/g)]
  const last = boundaries.at(-1)
  let boundary = last ? last.index! + last[0].length : 0
  // A short heading alone supplies too little audio to cover the next inference.
  if (boundary < limit / 3) boundary = 0
  if (!boundary) {
    const space = prefix.lastIndexOf(" ")
    boundary = space > 0 ? space + 1 : limit
  }
  const previous = text.charCodeAt(boundary - 1)
  const next = text.charCodeAt(boundary)
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    boundary -= 1
  return boundary
}

/** Preserves ordered words, using the same opening for preparation and playback. */
export function splitSpeechText(text: string): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining) {
    const limit =
      chunks.length === 0
        ? SPEECH_OPENING_CHARS
        : chunks.length === 1
          ? SPEECH_SECOND_SECTION_CHARS
          : SPEECH_SECTION_CHARS
    const boundary =
      remaining.length <= limit
        ? remaining.length
        : speechBoundary(remaining, limit)
    const chunk = remaining.slice(0, boundary).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(boundary).trim()
  }
  return chunks
}
