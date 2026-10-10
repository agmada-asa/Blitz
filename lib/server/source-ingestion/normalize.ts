/** Normalizes extracted source text while retaining explicit attribution markers. */

import { createHash } from "node:crypto"
import { SourceIngestionError } from "./errors.ts"
import type {
  NormalizedSourceDocument,
  SourceDocumentInput,
  SourceMarker,
  SourceMarkerKind,
  SourceReference,
} from "./types.ts"

/** Maximum filename length accepted at the ingestion boundary. */
export const MAX_SOURCE_FILENAME_LENGTH = 255
/** Maximum normalized characters accepted from one source. */
export const MAX_SOURCE_TEXT_LENGTH = 20_000_000
/** Maximum UTF-8 bytes accepted from one source. */
export const MAX_SOURCE_TEXT_BYTES = 25_000_000

const SOURCE_KINDS = new Set<SourceDocumentInput["kind"]>([
  "pdf",
  "markdown",
  "text",
  "transcript",
  "powerpoint",
  "url",
])

/** Hashes bounded metadata and text to create a repeatable source identifier. */
function deriveSourceId(
  input: SourceDocumentInput,
  normalizedText: string
): string {
  return `source_${createHash("sha256")
    .update(input.kind)
    .update("\0")
    .update(input.filename ?? "")
    .update("\0")
    .update(normalizedText)
    .digest("hex")
    .slice(0, 24)}`
}

/** Converts a marker token into a typed marker while preserving its visible label. */
function markerFromMatch(
  lineStart: number,
  tokenStart: number,
  tokenEnd: number,
  kind: SourceMarkerKind,
  label: string,
  value: string
): SourceMarker {
  return {
    kind,
    label,
    value,
    startOffset: lineStart + tokenStart,
    endOffset: lineStart + tokenEnd,
  }
}

/** Finds explicit page, slide, and timestamp prefixes without adding synthetic labels. */
export function detectSourceMarkers(text: string): SourceMarker[] {
  const markers: SourceMarker[] = []
  let lineStart = 0

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    const pageOrSlide = line.match(/^\s*\[(page|slide)\s+([^\]]+)\]/i)
    const bracketedTime = line.match(/^\s*\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/)
    const plainTime = line.match(/^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$)/)

    if (pageOrSlide) {
      const label = pageOrSlide[0].trim()
      const kind = pageOrSlide[1].toLowerCase() as "page" | "slide"
      const value = pageOrSlide[2].trim()
      const tokenStart =
        line.indexOf(pageOrSlide[0]) + pageOrSlide[0].search(/\[/)
      const tokenEnd = tokenStart + pageOrSlide[0].trimStart().length
      markers.push(
        markerFromMatch(lineStart, tokenStart, tokenEnd, kind, label, value)
      )
    } else if (bracketedTime) {
      const label = bracketedTime[0].trim()
      const value = bracketedTime[1]
      const tokenStart =
        line.indexOf(bracketedTime[0]) + bracketedTime[0].indexOf("[")
      markers.push(
        markerFromMatch(
          lineStart,
          tokenStart,
          tokenStart + bracketedTime[0].trimStart().length,
          "time",
          label,
          value
        )
      )
    } else if (
      plainTime &&
      (line.length > plainTime[0].length || line.includes("--"))
    ) {
      const label = plainTime[1]
      const tokenStart = line.indexOf(plainTime[1])
      markers.push(
        markerFromMatch(
          lineStart,
          tokenStart,
          tokenStart + plainTime[0].trimStart().length,
          "time",
          label,
          label
        )
      )
    }

    if (newline === -1) break
    lineStart = newline + 1
  }

  return markers
}

/** Builds deterministic spans from marker positions, retaining the marker's exact label. */
function buildReferences(
  filename: string | undefined,
  textLength: number,
  markers: SourceMarker[]
): SourceReference[] {
  if (markers.length === 0) {
    return filename ? [{ filename, startOffset: 0, endOffset: textLength }] : []
  }

  const prefix =
    filename && markers[0]!.startOffset > 0
      ? [{ filename, startOffset: 0, endOffset: markers[0]!.startOffset }]
      : []
  return [
    ...prefix,
    ...markers.map((marker, index) => ({
      ...(filename ? { filename } : {}),
      marker,
      startOffset: marker.startOffset,
      endOffset: markers[index + 1]?.startOffset ?? textLength,
    })),
  ]
}

/** Normalizes one extracted text source and rejects oversized or malformed input with context. */
export function normalizeSourceDocument(
  input: SourceDocumentInput
): NormalizedSourceDocument {
  if (!input || typeof input !== "object") {
    throw new SourceIngestionError("invalid-input", "Source input is required")
  }
  if (!SOURCE_KINDS.has(input.kind)) {
    throw new SourceIngestionError(
      "invalid-input",
      "Source kind is not supported"
    )
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new SourceIngestionError("invalid-input", "Source text is required")
  }

  const filename = input.filename?.trim() || undefined
  if (filename && filename.length > MAX_SOURCE_FILENAME_LENGTH) {
    throw new SourceIngestionError(
      "input-too-large",
      "Source filename is too long",
      {
        filenameLength: filename.length,
        maxFilenameLength: MAX_SOURCE_FILENAME_LENGTH,
      }
    )
  }

  const text = input.text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
  const byteLength = Buffer.byteLength(text, "utf8")
  if (!text) {
    throw new SourceIngestionError("invalid-input", "Source text is empty")
  }
  if (
    text.length > MAX_SOURCE_TEXT_LENGTH ||
    byteLength > MAX_SOURCE_TEXT_BYTES
  ) {
    throw new SourceIngestionError(
      "input-too-large",
      "Source text exceeds the ingestion limit",
      {
        characterCount: text.length,
        byteCount: byteLength,
        maxCharacters: MAX_SOURCE_TEXT_LENGTH,
        maxBytes: MAX_SOURCE_TEXT_BYTES,
      }
    )
  }

  const markers = detectSourceMarkers(text)
  return {
    sourceId: input.sourceId?.trim() || deriveSourceId(input, text),
    ...(filename ? { filename } : {}),
    kind: input.kind,
    text,
    markers,
    references: buildReferences(filename, text.length, markers),
  }
}
