/** Verifies bounded extraction for remote downloads and file-backed local sources. */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { strToU8, zipSync } from "fflate"

import {
  extractDownloadedSource,
  extractStoredSource,
  MAX_DOWNLOADED_SOURCE_BYTES,
} from "../lib/server/source-ingestion/extract.ts"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"
import { splitSourceText } from "../lib/source-splitting.ts"

/** Builds deterministic PDF pages with selectable text kept inside each page's bounds. */
function makePdf(
  pageTexts: readonly string[],
  leadingCommentBytes = 0
): Uint8Array {
  const pageReferences = pageTexts
    .map((_, index) => `${3 + index} 0 R`)
    .join(" ")
  const pageObjects = pageTexts.map((_, index) => {
    const contentNumber = 3 + pageTexts.length + index
    return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pageTexts.length * 2} 0 R >> >> /Contents ${contentNumber} 0 R >>`
  })
  const contentObjects = pageTexts.map((text) => {
    const lines = text.match(/.{1,80}/g) ?? [""]
    const stream = `BT /F1 11 Tf 14 TL 72 720 Td ${lines.map((line, index) => `${index ? "T* " : ""}(${line}) Tj`).join(" ")} ET`
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageTexts.length} >>`,
    ...pageObjects,
    ...contentObjects,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = `%PDF-1.4\n${leadingCommentBytes ? `%${"x".repeat(leadingCommentBytes)}\n` : ""}`
  const offsets = [0]
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "binary"))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(pdf, "binary"))
}

/** Asserts that a failed extraction exposes a stable, actionable ingestion error. */
function assertIngestionError(error: unknown, code: string): void {
  assert.ok(error instanceof SourceIngestionError)
  assert.equal(error.code, code)
}

test("extracts PDF text with page markers", async () => {
  const result = await extractDownloadedSource({
    bytes: makePdf(["First page notes", "Second page notes"]),
    contentType: "application/pdf",
    url: "https://example.com/lecture.pdf",
  })

  assert.equal(result.filename, "lecture.pdf")
  assert.equal(result.kind, "pdf")
  assert.match(result.extractedText, /\[Page 1\]\nFirst page notes/)
  assert.match(result.extractedText, /\[Page 2\]\nSecond page notes/)
})

test("extracts a stored PDF larger than the research download limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-stored-pdf-"))
  const path = join(root, "large.pdf")
  try {
    const bytes = makePdf(
      ["A local PDF can be parsed without loading the full file."],
      MAX_DOWNLOADED_SOURCE_BYTES
    )
    await writeFile(path, bytes)
    assert.ok(bytes.byteLength > MAX_DOWNLOADED_SOURCE_BYTES)
    const result = await extractStoredSource({
      path,
      filename: "large.pdf",
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
    })
    assert.match(result.extractedText, /local PDF can be parsed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("extracts a stored JSON file through the text helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "blitz-stored-json-"))
  const path = join(root, "notes.json")
  const text = '{"topic":"Learning"}'
  try {
    await writeFile(path, text)
    const result = await extractStoredSource({
      path,
      filename: "notes.json",
      contentType: "application/json",
      sizeBytes: Buffer.byteLength(text),
    })
    assert.equal(result.extractedText, text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Covers book-sized extraction and splitting together so the old cap cannot return upstream. */
test("extracts and splits a PDF longer than one source document", async () => {
  const pages = Array.from(
    { length: 160 },
    (_, index) => `Page ${index + 1} ${"Learning source text. ".repeat(40)}`
  )
  const result = await extractDownloadedSource({
    bytes: makePdf(pages),
    contentType: "application/pdf",
    url: "https://example.com/book.pdf",
  })
  assert.ok(result.extractedText.length > 120_000)
  const parts = splitSourceText(result.extractedText)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.text.length <= 120_000))
  assert.equal(
    parts
      .map((part) => part.text.replace(/^\[Part \d+ of \d+\]\n/, ""))
      .join(""),
    result.extractedText
  )
  assert.match(result.extractedText, /\[Page 160\]/)
})

test("extracts readable main HTML text and markdown", async () => {
  const html = await extractDownloadedSource({
    bytes: new TextEncoder().encode(
      "<html><body><nav>Skip</nav><main><h1>Title</h1><p>Useful &amp; clear notes.</p><script>ignore()</script></main></body></html>"
    ),
    contentType: "text/html; charset=utf-8",
    url: "https://example.com/notes",
  })
  const markdown = await extractDownloadedSource({
    bytes: new TextEncoder().encode("# Heading\n\nBody"),
    contentType: "text/markdown",
    url: "https://example.com/notes.md",
  })

  assert.equal(html.kind, "text")
  assert.equal(html.extractedText, "Title\nUseful & clear notes.")
  assert.equal(markdown.kind, "markdown")
  assert.equal(markdown.extractedText, "# Heading\n\nBody")
})

test("extracts text and slide markers from a bounded PPTX", async () => {
  const result = await extractDownloadedSource({
    bytes: zipSync({
      "ppt/slides/slide1.xml": strToU8(
        '<p:sld xmlns:a="urn:test"><a:t>Slide</a:t><a:t>notes</a:t></p:sld>'
      ),
    }),
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    url: "https://example.com/lesson.pptx",
  })

  assert.equal(result.filename, "lesson.pptx")
  assert.equal(result.kind, "text")
  assert.equal(result.extractedText, "[Slide 1]\nSlide notes")
})

test("rejects a PPTX whose slides contain no readable text", async () => {
  await assert.rejects(
    extractDownloadedSource({
      bytes: zipSync({
        "ppt/slides/slide1.xml": strToU8(
          '<p:sld xmlns:a="urn:test"><a:spTree /></p:sld>'
        ),
      }),
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      url: "https://example.com/empty.pptx",
    }),
    /presentation contains no readable text/i
  )
})

test("rejects empty and oversized downloads with bounded errors", async () => {
  await assert.rejects(
    extractDownloadedSource({
      bytes: new Uint8Array(),
      contentType: "text/plain",
      url: "https://example.com/empty.txt",
    }),
    (error: unknown) => {
      assertIngestionError(error, "invalid-input")
      return true
    }
  )

  await assert.rejects(
    extractDownloadedSource({
      bytes: new Uint8Array(MAX_DOWNLOADED_SOURCE_BYTES + 1),
      contentType: "text/plain",
      url: "https://example.com/large.txt",
    }),
    (error: unknown) => {
      assertIngestionError(error, "input-too-large")
      return true
    }
  )
})

test("reports scanned PDFs as an OCR limitation", async () => {
  const pdfWithoutText = makePdf([""])
  await assert.rejects(
    extractDownloadedSource({
      bytes: pdfWithoutText,
      contentType: "application/pdf",
      url: "https://example.com/scanned.pdf",
    }),
    /scanned document.*OCR/i
  )
})
