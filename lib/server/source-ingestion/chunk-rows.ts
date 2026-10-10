/**
 * Shapes source chunks into the rows Convex stores in `sourceChunks`.
 *
 * Uploads and approved research imports both split their text here, so every
 * source gets the same passages, page, slide, and timestamp references, and
 * therefore the same citations in Teach and chat.
 */

import { normalizeSourceDocument } from "./normalize.ts"
import { segmentSourceDocument } from "./segment.ts"
import type { SourceChunk, SourceDocumentKind } from "./types.ts"

/** One chunk as accepted by `sourceRetrieval.replaceChunks` and `research.completeImport`. */
export interface PersistedChunkRow {
  /** Zero-based order in the source. */
  ordinal: number
  /** Exact slice of the stored source text. */
  text: string
  /** Stable content hash used to recognise unchanged chunks. */
  textHash: string
  /** Inclusive start offset in the stored source text. */
  startOffset: number
  /** Exclusive end offset in the stored source text. */
  endOffset: number
  /** Page, slide, and timestamp spans that intersect the chunk. */
  references: Array<{
    kind?: "page" | "slide" | "time"
    value: string
    label: string
    startOffset: number
    endOffset: number
  }>
}

/**
 * Converts segmented chunks into persisted rows.
 *
 * A span without a marker (text before the first page, or a source with no
 * markers) keeps the filename as its label and an empty value.
 */
export function persistedChunkRows(
  chunks: readonly SourceChunk[]
): PersistedChunkRow[] {
  return chunks.map((chunk) => ({
    ordinal: chunk.ordinal,
    text: chunk.text,
    textHash: chunk.id.replace(/^chunk_/, ""),
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    references: chunk.references.map((reference) => ({
      ...(reference.marker ? { kind: reference.marker.kind } : {}),
      value: reference.marker?.value ?? "",
      label: reference.marker?.label ?? reference.filename ?? "Source",
      startOffset: reference.startOffset,
      endOffset: reference.endOffset,
    })),
  }))
}

/** Text to store on the source row and the chunks whose offsets refer to it. */
export interface PreparedTextSource {
  /** Normalized text; chunk offsets index into exactly this string. */
  text: string
  /** Chunks ready to persist with the source. */
  chunks: PersistedChunkRow[]
}

/**
 * Normalizes already extracted text and splits it into persisted chunks.
 *
 * @param input.seed Stable identity mixed into chunk hashes, such as an import ID and part number.
 * @throws SourceIngestionError when the text is empty or exceeds the ingestion limits.
 */
export function prepareTextSource(input: {
  seed: string
  filename: string
  kind: SourceDocumentKind
  text: string
}): PreparedTextSource {
  const document = normalizeSourceDocument({
    sourceId: input.seed,
    filename: input.filename,
    kind: input.kind,
    text: input.text,
  })
  return {
    text: document.text,
    chunks: persistedChunkRows(segmentSourceDocument(document)),
  }
}
