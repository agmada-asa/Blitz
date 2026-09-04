/** Defines the normalized source and chunk contracts shared by server ingestion steps. */

/** Source categories accepted by the normalized ingestion boundary. */
export type SourceDocumentKind =
  "pdf" | "markdown" | "text" | "transcript" | "powerpoint" | "url"

/** Marker categories that can be preserved as source attribution. */
export type SourceMarkerKind = "page" | "slide" | "time"

/** An explicit location marker found in extracted source text. */
export interface SourceMarker {
  /** Marker type inferred from its explicit label. */
  kind: SourceMarkerKind
  /** Label exactly as it appeared in the source, trimmed but not invented. */
  label: string
  /** Page, slide, or timestamp value represented by the label. */
  value: string
  /** Inclusive start offset of the marker in normalized text. */
  startOffset: number
  /** Exclusive end offset of the marker token in normalized text. */
  endOffset: number
}

/** A deterministic source span used to attribute a normalized document or chunk. */
export interface SourceReference {
  /** Original filename when one was supplied by the caller. */
  filename?: string
  /** Explicit page, slide, or timestamp marker covering this span. */
  marker?: SourceMarker
  /** Inclusive start offset of the attributed source span. */
  startOffset: number
  /** Exclusive end offset of the attributed source span. */
  endOffset: number
}

/** Text and attribution data after bounded normalization. */
export interface NormalizedSourceDocument {
  /** Stable caller-provided or content-derived source identifier. */
  sourceId: string
  /** Original filename, if the source came from a named file. */
  filename?: string
  /** Explicit source category supplied by the caller. */
  kind: SourceDocumentKind
  /** Normalized text with line endings made deterministic. */
  text: string
  /** Every explicit marker found in the normalized text. */
  markers: SourceMarker[]
  /** Deterministic attribution spans covering the document where possible. */
  references: SourceReference[]
}

/** Input accepted by the normalization boundary. */
export interface SourceDocumentInput {
  /** Optional stable identifier from persistence or an import job. */
  sourceId?: string
  /** Optional user-visible filename; it is retained for attribution only. */
  filename?: string
  /** Source category for downstream format-specific processing. */
  kind: SourceDocumentKind
  /** Extracted text; binary parsing belongs to an upstream adapter. */
  text: string
}

/** One bounded, overlapping unit suitable for concept processing. */
export interface SourceChunk {
  /** Stable identifier derived from source identity, position, and text. */
  id: string
  /** Identifier of the normalized source document. */
  sourceId: string
  /** Zero-based order in the source document. */
  ordinal: number
  /** Exact normalized text slice, including any intentional overlap whitespace. */
  text: string
  /** Inclusive start offset in the normalized document. */
  startOffset: number
  /** Exclusive end offset in the normalized document. */
  endOffset: number
  /** Explicit source attribution spans that intersect this chunk. */
  references: SourceReference[]
}
