/** Extracts bounded text from approved downloaded PDF, HTML, Markdown, and text sources. */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { unzipSync } from "fflate"
import { SourceIngestionError } from "./errors.ts"

/** Maximum downloaded bytes accepted by the research extraction boundary. */
export const MAX_DOWNLOADED_SOURCE_BYTES = 5_000_000
/** Maximum extracted text accepted before the importer splits it into parts. */
export const MAX_DOWNLOADED_TEXT_LENGTH = 2_000_000
/** Maximum PDF pages inspected by one extraction request. */
export const MAX_PDF_PAGES = 500
/** Maximum uncompressed slide XML retained while reading one PPTX archive. */
export const MAX_PPTX_XML_BYTES = 20_000_000
/** Maximum uncompressed size accepted for one PPTX slide XML entry. */
export const MAX_PPTX_SLIDE_BYTES = 1_000_000

/** Download payload accepted by the bounded server extractor. */
export interface DownloadedSourceInput {
  /** Bounded bytes returned by the public-source fetch boundary. */
  readonly bytes: Uint8Array
  /** Response media type, optionally including parameters. */
  readonly contentType: string | null
  /** Validated final URL used to derive a stable filename. */
  readonly url: string
}

/** Extracted source payload ready for the research import mutation. */
export interface ExtractedDownloadedSource {
  /** User-visible filename derived from the final URL. */
  readonly filename: string
  /** Persistence-compatible source kind. */
  readonly kind: "pdf" | "markdown" | "text"
  /** Bounded readable text, with PDF page markers retained. */
  readonly extractedText: string
}

/** Returns the URL path's final segment as a safe bounded filename. */
function filenameForUrl(
  url: string,
  extension: ".pdf" | ".md" | ".txt" | ".pptx"
) {
  let candidate = ""
  try {
    const pathname = new URL(url).pathname
    candidate = decodeURIComponent(pathname.split("/").pop() ?? "")
  } catch {
    // The fetch boundary already validates URLs; use the bounded fallback if a caller violates it.
  }
  candidate = candidate.trim().replace(/[\u0000-\u001f\u007f]/g, "")
  if (!candidate || candidate === "." || candidate === "..")
    candidate = `research-source${extension}`
  else if (!candidate.includes(".")) candidate = `${candidate}${extension}`
  if (candidate.length > 255) candidate = candidate.slice(0, 255)
  return candidate
}

/** Ensures extracted text is non-empty and within the persisted source bound. */
function boundExtractedText(text: string, format: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim()
  if (!normalized) {
    throw new SourceIngestionError(
      "invalid-input",
      format === "pdf"
        ? "The PDF contains no extractable text; it may be a scanned document and needs OCR."
        : "The downloaded source contains no readable text",
      { format }
    )
  }
  if (normalized.length > MAX_DOWNLOADED_TEXT_LENGTH) {
    throw new SourceIngestionError(
      "input-too-large",
      "The downloaded source contains more text than the import limit",
      {
        format,
        characterCount: normalized.length,
        maxCharacters: MAX_DOWNLOADED_TEXT_LENGTH,
      }
    )
  }
  return normalized
}

/** Converts a small set of HTML entities without pretending to fully parse HTML. */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-f]+|nbsp|amp|lt|gt|quot|apos);/gi,
    (entity, value: string) => {
      const lower = value.toLowerCase()
      if (lower === "nbsp") return " "
      if (lower === "amp") return "&"
      if (lower === "lt") return "<"
      if (lower === "gt") return ">"
      if (lower === "quot") return '"'
      if (lower === "apos") return "'"
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10)
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity
    }
  )
}

/** Extracts visible text from a known PresentationML slide XML shape. */
function extractSlideXmlText(xml: string): string {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>/gi)]
    .map((match) =>
      decodeHtmlEntities(match[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" ")
}

/** Extracts bounded slide text from a PPTX archive without browser APIs. */
function extractPptxText(bytes: Uint8Array): string {
  let uncompressedXmlBytes = 0
  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(bytes, {
      filter: (entry) => {
        if (!/^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)) return false
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0)
          throw new SourceIngestionError(
            "input-too-large",
            "The presentation contains an invalid slide size"
          )
        if (entry.originalSize > MAX_PPTX_SLIDE_BYTES)
          throw new SourceIngestionError(
            "input-too-large",
            "The presentation contains a slide that is too large",
            { maxSlideBytes: MAX_PPTX_SLIDE_BYTES }
          )
        uncompressedXmlBytes += entry.originalSize
        if (uncompressedXmlBytes > MAX_PPTX_XML_BYTES)
          throw new SourceIngestionError(
            "input-too-large",
            "The presentation contains more slide data than the import limit",
            { maxBytes: MAX_PPTX_XML_BYTES }
          )
        return true
      },
    })
  } catch (error) {
    if (error instanceof SourceIngestionError) throw error
    throw new SourceIngestionError(
      "invalid-input",
      "The PowerPoint file could not be read. It may be malformed.",
      { format: "pptx" }
    )
  }

  const slideNames = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      const rightNumber = Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      return leftNumber - rightNumber
    })
  let readableSlideFound = false
  const slides = slideNames
    .map((name) => {
      const slideNumber = Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      const text = extractSlideXmlText(new TextDecoder().decode(archive[name]))
      if (!text) return ""
      readableSlideFound = true
      return `[Slide ${slideNumber}]\n${text}`
    })
    .filter(Boolean)
  if (!readableSlideFound)
    throw new SourceIngestionError(
      "invalid-input",
      "The presentation contains no readable text",
      { format: "pptx" }
    )
  return slides.join("\n\n")
}

/** Extracts readable text from a main/article region or the whole HTML document. */
function extractHtmlText(raw: string): string {
  const region =
    raw.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] ??
    raw.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1] ??
    raw
  return decodeHtmlEntities(
    region
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(
        /<\/?(?:p|div|section|article|main|h[1-6]|li|br|tr)\b[^>]*>/gi,
        "\n"
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}

/** Extracts text from every PDF page while retaining bounded page attribution. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfOptions = {
    data: bytes,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
  } as Parameters<typeof getDocument>[0] & { isEvalSupported?: boolean }
  const loadingTask = getDocument(pdfOptions)
  try {
    const document = await loadingTask.promise
    if (document.numPages > MAX_PDF_PAGES) {
      throw new SourceIngestionError(
        "input-too-large",
        "The PDF has more pages than the import limit",
        { pageCount: document.numPages, maxPages: MAX_PDF_PAGES }
      )
    }
    const pages: string[] = []
    let readablePageFound = false
    let extractedCharacterCount = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent({
          includeMarkedContent: false,
        })
        const pageText = content.items
          .map((item) =>
            "str" in item && typeof item.str === "string" ? item.str : ""
          )
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        if (pageText) readablePageFound = true
        const pageOutput = `[Page ${pageNumber}]${pageText ? `\n${pageText}` : ""}`
        const separatorLength = pages.length ? 2 : 0
        if (
          extractedCharacterCount + separatorLength + pageOutput.length >
          MAX_DOWNLOADED_TEXT_LENGTH
        )
          throw new SourceIngestionError(
            "input-too-large",
            "The downloaded source contains more text than the import limit",
            {
              format: "pdf",
              maxCharacters: MAX_DOWNLOADED_TEXT_LENGTH,
            }
          )
        extractedCharacterCount += separatorLength + pageOutput.length
        pages.push(pageOutput)
      } finally {
        page.cleanup()
      }
    }
    if (!readablePageFound) {
      throw new SourceIngestionError(
        "invalid-input",
        "The PDF contains no extractable text; it may be a scanned document and needs OCR.",
        { format: "pdf" }
      )
    }
    return pages.join("\n\n")
  } finally {
    await loadingTask.destroy().catch(() => undefined)
  }
}

/** Selects a supported format from the response type, URL suffix, or PDF signature. */
function detectFormat(
  bytes: Uint8Array,
  contentType: string | null,
  url: string
): "pdf" | "markdown" | "html" | "text" | "pptx" {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase() ?? ""
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ""
    }
  })()
  if (mediaType === "application/pdf" || pathname.endsWith(".pdf")) return "pdf"
  if (
    mediaType === "text/markdown" ||
    mediaType === "text/x-markdown" ||
    pathname.endsWith(".md") ||
    pathname.endsWith(".markdown")
  )
    return "markdown"
  if (
    mediaType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    pathname.endsWith(".pptx")
  )
    return "pptx"
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".htm")
  )
    return "html"
  if (
    bytes.length >= 5 &&
    new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-"
  )
    return "pdf"
  if (mediaType === "text/plain" || mediaType === "text/csv" || !mediaType)
    return "text"
  throw new SourceIngestionError(
    "invalid-input",
    "This downloaded source format is not supported for import",
    { contentType: mediaType || "unknown" }
  )
}

/** Extracts an approved downloaded source with bounded parsing and actionable failures. */
export async function extractDownloadedSource(
  input: DownloadedSourceInput
): Promise<ExtractedDownloadedSource> {
  if (!input || !(input.bytes instanceof Uint8Array))
    throw new SourceIngestionError(
      "invalid-input",
      "Downloaded source bytes are required"
    )
  if (input.bytes.byteLength > MAX_DOWNLOADED_SOURCE_BYTES) {
    throw new SourceIngestionError(
      "input-too-large",
      "Downloaded source exceeds the import byte limit",
      {
        byteCount: input.bytes.byteLength,
        maxBytes: MAX_DOWNLOADED_SOURCE_BYTES,
      }
    )
  }
  if (!input.bytes.byteLength)
    throw new SourceIngestionError(
      "invalid-input",
      "Downloaded source is empty"
    )

  const format = detectFormat(input.bytes, input.contentType, input.url)
  let extractedText: string
  if (format === "pdf") {
    try {
      extractedText = await extractPdfText(input.bytes)
    } catch (error) {
      if (error instanceof SourceIngestionError) throw error
      throw new SourceIngestionError(
        "invalid-input",
        "The PDF could not be read. It may be encrypted or malformed.",
        { format: "pdf" }
      )
    }
  } else if (format === "pptx") {
    extractedText = extractPptxText(input.bytes)
  } else {
    const raw = new TextDecoder().decode(input.bytes)
    extractedText = format === "html" ? extractHtmlText(raw) : raw
  }

  return {
    filename: filenameForUrl(
      input.url,
      format === "pdf"
        ? ".pdf"
        : format === "markdown"
          ? ".md"
          : format === "pptx"
            ? ".pptx"
            : ".txt"
    ),
    kind:
      format === "pdf" ? "pdf" : format === "markdown" ? "markdown" : "text",
    extractedText: boundExtractedText(extractedText, format),
  }
}
