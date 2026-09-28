/**
 * Turns a project-local original into normalized text and generation sections.
 *
 * The upload route composes both stages through `prepareStoredSource`. The
 * ingestion eval calls the stages separately so it can report where a file
 * stops, while still measuring the exact behavior uploads use.
 */

import { SourceIngestionError } from "./errors.ts"
import {
  extractStoredSource,
  type ExtractedDownloadedSource,
  type StoredSourceInput,
} from "./extract.ts"
import { normalizeSourceDocument } from "./normalize.ts"
import { segmentSourceDocument } from "./segment.ts"
import type { NormalizedSourceDocument, SourceChunk } from "./types.ts"

/**
 * Largest normalized text, in UTF-8 bytes, that fits on a Convex source row.
 * Uploads above it are saved without extracted text or sections.
 */
export const MAX_PREPARED_TEXT_BYTES = 500_000

/** Extracted text and its normalized document, before any size bound. */
export interface ExtractedStoredSource {
  /** Readable text and detected kind returned by extraction. */
  extracted: ExtractedDownloadedSource
  /** Normalized text with explicit page, slide, and time markers. */
  document: NormalizedSourceDocument
}

/** A stored original that passed every stage and has generation sections. */
export interface PreparedStoredSource extends ExtractedStoredSource {
  /** Deterministic sections used for coverage and generation. */
  chunks: SourceChunk[]
}

/**
 * Extracts and normalizes one stored original.
 *
 * @param input Validated original file location and metadata.
 * @param sourceId Persisted source ID that makes section IDs stable.
 * @returns Extracted text and its normalized document.
 * @throws SourceIngestionError when the format is unreadable or exceeds an
 *   extraction limit such as the PDF page or character cap.
 */
export async function extractNormalizedStoredSource(
  input: StoredSourceInput,
  sourceId: string
): Promise<ExtractedStoredSource> {
  const extracted = await extractStoredSource(input)
  const document = normalizeSourceDocument({
    sourceId,
    filename: input.filename,
    kind: extracted.kind,
    text: extracted.extractedText,
  })
  return { extracted, document }
}

/**
 * Applies the persistence bound and splits a normalized document into sections.
 *
 * @param document Normalized source text.
 * @returns Sections in document order.
 * @throws SourceIngestionError when the text exceeds
 *   {@link MAX_PREPARED_TEXT_BYTES} or segmentation exceeds its chunk limit.
 */
export function segmentPreparedDocument(
  document: NormalizedSourceDocument
): SourceChunk[] {
  if (Buffer.byteLength(document.text, "utf8") > MAX_PREPARED_TEXT_BYTES)
    throw new SourceIngestionError(
      "input-too-large",
      "Extracted text exceeds the automatic preparation boundary.",
      { maxBytes: MAX_PREPARED_TEXT_BYTES }
    )
  return segmentSourceDocument(document)
}

/**
 * Runs every preparation stage for one stored original.
 *
 * @param input Validated original file location and metadata.
 * @param sourceId Persisted source ID that makes section IDs stable.
 * @returns The prepared document and its sections.
 * @throws SourceIngestionError from either stage.
 */
export async function prepareStoredSource(
  input: StoredSourceInput,
  sourceId: string
): Promise<PreparedStoredSource> {
  const extracted = await extractNormalizedStoredSource(input, sourceId)
  return { ...extracted, chunks: segmentPreparedDocument(extracted.document) }
}
