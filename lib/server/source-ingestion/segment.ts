/** Splits normalized source text into bounded, overlapping chunks with stable attribution. */

import { createHash } from "node:crypto"
import { SourceIngestionError } from "./errors.ts"
import type {
  NormalizedSourceDocument,
  SourceChunk,
  SourceReference,
} from "./types.ts"

/** Default maximum characters sent to one concept-processing call. */
export const DEFAULT_CHUNK_SIZE = 5_000
/** Default overlap retained between adjacent concept-processing chunks. */
export const DEFAULT_CHUNK_OVERLAP = 400
/** Default maximum chunks emitted for one source. */
export const DEFAULT_MAX_CHUNKS = 1_000

/** Returns the last preferred paragraph, line, or whitespace boundary in a range. */
function preferredBoundary(
  text: string,
  start: number,
  target: number
): number {
  const minimum = start + Math.max(1, Math.floor((target - start) / 2))
  const paragraph = text.lastIndexOf("\n\n", target - 1)
  if (paragraph >= minimum) return Math.min(target, paragraph + 2)
  const line = text.lastIndexOf("\n", target - 1)
  if (line >= minimum) return line + 1
  for (let index = target; index > minimum; index -= 1) {
    if (/\s/.test(text[index - 1] ?? "")) return index
  }
  return target
}

/** Moves a chunk boundary away from the middle of a UTF-16 surrogate pair. */
function safeBoundary(
  text: string,
  boundary: number,
  direction: "start" | "end"
): number {
  if (
    boundary > 0 &&
    boundary < text.length &&
    /[\uDC00-\uDFFF]/.test(text[boundary] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[boundary - 1] ?? "")
  ) {
    return boundary - 1
  }
  if (
    direction === "start" &&
    boundary < text.length &&
    /[\uDC00-\uDFFF]/.test(text[boundary] ?? "")
  ) {
    return Math.max(0, boundary - 1)
  }
  return boundary
}

/** Returns only source references whose attributed spans intersect a chunk range. */
function referencesForRange(
  references: SourceReference[],
  startOffset: number,
  endOffset: number
): SourceReference[] {
  return references.filter(
    (reference) =>
      reference.startOffset < endOffset && reference.endOffset > startOffset
  )
}

/** Derives a stable chunk identifier without exposing source text in the identifier. */
function chunkId(
  sourceId: string,
  ordinal: number,
  startOffset: number,
  endOffset: number,
  text: string
): string {
  return `chunk_${createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(String(ordinal))
    .update("\0")
    .update(String(startOffset))
    .update("\0")
    .update(String(endOffset))
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 24)}`
}

/** Validates chunk options before processing a source. */
function validateOptions(
  chunkSize: number,
  overlap: number,
  maxChunks: number
): void {
  if (!Number.isInteger(chunkSize) || chunkSize < 256) {
    throw new SourceIngestionError(
      "invalid-input",
      "Chunk size must be an integer of at least 256 characters",
      { chunkSize }
    )
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new SourceIngestionError(
      "invalid-input",
      "Chunk overlap must be an integer smaller than the chunk size",
      { overlap, chunkSize }
    )
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new SourceIngestionError(
      "invalid-input",
      "Maximum chunk count must be a positive integer",
      { maxChunks }
    )
  }
}

/** Segments normalized text without dropping characters and retains explicit source references. */
export function segmentSourceDocument(
  document: NormalizedSourceDocument,
  options: {
    chunkSize?: number
    overlap?: number
    maxChunks?: number
  } = {}
): SourceChunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS
  validateOptions(chunkSize, overlap, maxChunks)

  const chunks: SourceChunk[] = []
  let startOffset = 0
  while (startOffset < document.text.length) {
    const targetEnd = Math.min(startOffset + chunkSize, document.text.length)
    const endOffset = safeBoundary(
      document.text,
      targetEnd === document.text.length
        ? targetEnd
        : preferredBoundary(document.text, startOffset, targetEnd),
      "end"
    )
    const text = document.text.slice(startOffset, endOffset)
    if (!text) {
      throw new SourceIngestionError(
        "invalid-input",
        "Source segmentation reached an empty boundary",
        { startOffset, endOffset }
      )
    }
    if (chunks.length >= maxChunks) {
      throw new SourceIngestionError(
        "chunk-limit-exceeded",
        "Source produces more chunks than the processing limit",
        {
          sourceId: document.sourceId,
          maxChunks,
          characterCount: document.text.length,
        }
      )
    }

    const ordinal = chunks.length
    chunks.push({
      id: chunkId(document.sourceId, ordinal, startOffset, endOffset, text),
      sourceId: document.sourceId,
      ordinal,
      text,
      startOffset,
      endOffset,
      references: referencesForRange(
        document.references,
        startOffset,
        endOffset
      ),
    })

    if (endOffset >= document.text.length) break
    const nextStart = Math.max(startOffset + 1, endOffset - overlap)
    startOffset = safeBoundary(document.text, nextStart, "start")
  }
  return chunks
}
