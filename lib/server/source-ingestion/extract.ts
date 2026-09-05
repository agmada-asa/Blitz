/** Extracts bounded text from downloaded or project-local PDF, HTML, Markdown, text, and PPTX sources. */

import { createReadStream } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { unzipSync } from "fflate"
import { SourceIngestionError } from "./errors.ts"
import { MAX_ORIGINAL_SOURCE_BYTES } from "../source-files.ts"

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
/** Maximum local PPTX bytes read into memory by the ZIP parser. */
export const MAX_LOCAL_PPTX_BYTES = 20_000_000

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

/** Project-local original file accepted by the file-backed extraction path. */
export interface StoredSourceInput {
  /** Validated absolute path resolved through the project filesystem boundary. */
  readonly path: string
  /** Original user-visible filename without the storage hash prefix. */
  readonly filename: string
  /** Media type reported when the original upload was stored. */
  readonly contentType: string | null
  /** Stored byte count used to reject files beyond the upload boundary. */
  readonly sizeBytes: number
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
async function extractPdfText(
  source: { bytes: Uint8Array } | { path: string }
): Promise<string> {
  const pdfOptions = (
    "bytes" in source
      ? {
          data: source.bytes,
          disableAutoFetch: true,
          disableRange: true,
          disableStream: true,
        }
      : {
          url: pathToFileURL(source.path),
          // Range reads keep large local PDFs out of the server's heap.
          disableAutoFetch: true,
          disableStream: true,
        }
  ) as Parameters<typeof getDocument>[0] & { isEvalSupported?: boolean }
  Object.assign(pdfOptions, {
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
  })
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

/** Reads enough local bytes to identify a stored source without loading its body. */
async function readStoredSourceHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const bytes = new Uint8Array(16)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return bytes.slice(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Reads bounded UTF-8 text from disk and stops once the import limit is crossed. */
async function readStoredText(path: string): Promise<string> {
  const chunks: string[] = []
  let characterCount = 0
  const stream = createReadStream(path, { encoding: "utf8" })
  for await (const chunk of stream) {
    characterCount += chunk.length
    if (characterCount > MAX_DOWNLOADED_TEXT_LENGTH) {
      stream.destroy()
      throw new SourceIngestionError(
        "input-too-large",
        "The stored source contains more text than the import limit",
        { maxCharacters: MAX_DOWNLOADED_TEXT_LENGTH }
      )
    }
    chunks.push(chunk)
  }
  return chunks.join("")
}

/** Extracts a project-local original while keeping large PDF bytes on disk. */
export async function extractStoredSource(
  input: StoredSourceInput
): Promise<ExtractedDownloadedSource> {
  if (
    !input ||
    typeof input.path !== "string" ||
    !input.path ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1
  )
    throw new SourceIngestionError(
      "invalid-input",
      "Stored source metadata is required"
    )
  if (input.sizeBytes > MAX_ORIGINAL_SOURCE_BYTES)
    throw new SourceIngestionError(
      "input-too-large",
      "Stored source exceeds the 1 GB import limit",
      {
        byteCount: input.sizeBytes,
        maxBytes: MAX_ORIGINAL_SOURCE_BYTES,
      }
    )

  const url = `https://local.invalid/${encodeURIComponent(input.filename)}`
  const header = await readStoredSourceHeader(input.path)
  const format = detectFormat(header, input.contentType, url)
  let extractedText: string
  if (format === "pdf") {
    try {
      extractedText = await extractPdfText({ path: input.path })
    } catch (error) {
      if (error instanceof SourceIngestionError) throw error
      throw new SourceIngestionError(
        "invalid-input",
        "The PDF could not be read. It may be encrypted or malformed.",
        { format: "pdf" }
      )
    }
  } else if (format === "pptx") {
    if (input.sizeBytes > MAX_LOCAL_PPTX_BYTES)
      throw new SourceIngestionError(
        "input-too-large",
        "The PowerPoint file exceeds the 20 MB extraction limit",
        { maxBytes: MAX_LOCAL_PPTX_BYTES }
      )
    extractedText = extractPptxText(new Uint8Array(await readFile(input.path)))
  } else {
    const raw = await readStoredText(input.path)
    extractedText = format === "html" ? extractHtmlText(raw) : raw
  }
  const extension =
    format === "pdf"
      ? ".pdf"
      : format === "pptx"
        ? ".pptx"
        : format === "markdown"
          ? ".md"
          : ".txt"
  return {
    filename: filenameForUrl(url, extension),
    kind:
      format === "pdf" ? "pdf" : format === "markdown" ? "markdown" : "text",
    extractedText: boundExtractedText(extractedText, format),
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
      extractedText = await extractPdfText({ bytes: input.bytes })
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
