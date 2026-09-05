/** Splits large extracted source text into bounded, attributed upload parts. */

/** Maximum extracted text accepted before asking the user to choose smaller files. */
export const MAX_SPLITTABLE_SOURCE_LENGTH = 2_000_000

/** Maximum text stored in one Convex source document. */
export const MAX_SOURCE_PART_LENGTH = 120_000

/** Space reserved for the part attribution header in each bounded source. */
const PART_HEADER_RESERVE = 64

/** Maximum filename length accepted by the source mutation. */
const MAX_FILENAME_LENGTH = 255

/** One bounded source part and its stable position in the original text. */
export type SourcePart = {
  partNumber: number
  totalParts: number
  text: string
}

/** Moves a hard boundary away from the middle of a UTF-16 surrogate pair. */
function safeCodeUnitBoundary(text: string, boundary: number): number {
  if (
    boundary > 0 &&
    boundary < text.length &&
    /[\uD800-\uDBFF]/.test(text[boundary - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[boundary]!)
  )
    return boundary - 1
  return boundary
}

/** Chooses a nearby line or whitespace boundary without dropping characters. */
function choosePartEnd(
  text: string,
  start: number,
  maxBodyLength: number
): number {
  const hardEnd = safeCodeUnitBoundary(
    text,
    Math.min(text.length, start + maxBodyLength)
  )
  if (hardEnd >= text.length) return text.length
  const preferredStart = Math.max(
    start + 1,
    hardEnd - Math.floor(maxBodyLength / 3)
  )
  for (let index = hardEnd; index > preferredStart; index -= 1) {
    if (text[index - 1] === "\n" || text[index - 1] === "\r") return index
  }
  for (let index = hardEnd; index > preferredStart; index -= 1) {
    if (/\s/.test(text[index - 1]!)) return index
  }
  return hardEnd > start ? hardEnd : safeCodeUnitBoundary(text, start + 1)
}

/** Returns bounded parts whose concatenated bodies exactly equal the input. */
export function splitSourceText(
  text: string,
  options: { maxPartLength?: number } = {}
): SourcePart[] {
  const maxPartLength = options.maxPartLength ?? MAX_SOURCE_PART_LENGTH
  if (
    !Number.isSafeInteger(maxPartLength) ||
    maxPartLength <= PART_HEADER_RESERVE
  )
    throw new Error("Source part size is invalid")
  if (text.length > MAX_SPLITTABLE_SOURCE_LENGTH)
    throw new Error(
      "That source is too large to import at once. Split it into smaller files."
    )
  if (!text.length) return []
  if (text.length <= maxPartLength)
    return [{ partNumber: 1, totalParts: 1, text }]

  const maxBodyLength = maxPartLength - PART_HEADER_RESERVE
  const bodies: string[] = []
  let start = 0
  while (start < text.length) {
    const end = choosePartEnd(text, start, maxBodyLength)
    bodies.push(text.slice(start, end))
    start = end
  }
  const totalParts = bodies.length
  return bodies.map((body, index) => ({
    partNumber: index + 1,
    totalParts,
    text: `[Part ${index + 1} of ${totalParts}]\n${body}`,
  }))
}

/** Builds a part filename while retaining the original extension and attribution. */
export function sourcePartFilename(
  filename: string,
  partNumber: number,
  totalParts: number
): string {
  const trimmed = filename.trim() || "Imported source"
  const extensionMatch = trimmed.match(/\.[^./]+$/)
  const extension = extensionMatch?.[0] ?? ""
  const base = extension ? trimmed.slice(0, -extension.length) : trimmed
  if (totalParts <= 1) {
    const baseLength = Math.max(1, MAX_FILENAME_LENGTH - extension.length)
    return `${base.slice(0, baseLength)}${extension}`.slice(
      0,
      MAX_FILENAME_LENGTH
    )
  }
  const suffix = ` (Part ${partNumber} of ${totalParts})`
  const baseLength = Math.max(
    1,
    MAX_FILENAME_LENGTH - suffix.length - extension.length
  )
  return `${base.slice(0, baseLength)}${suffix}${extension}`.slice(
    0,
    MAX_FILENAME_LENGTH
  )
}
