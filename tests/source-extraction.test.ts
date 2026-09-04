/** Verifies bounded extraction for the approved research download formats. */

import assert from "node:assert/strict"
import test from "node:test"
import { strToU8, zipSync } from "fflate"

import {
  extractDownloadedSource,
  MAX_DOWNLOADED_SOURCE_BYTES,
} from "../lib/server/source-ingestion/extract.ts"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"

/** Builds a tiny deterministic two-page PDF fixture with selectable text. */
function makePdf(pageTexts: readonly string[]): Uint8Array {
  const pageReferences = pageTexts
    .map((_, index) => `${3 + index} 0 R`)
    .join(" ")
  const pageObjects = pageTexts.map((_, index) => {
    const contentNumber = 3 + pageTexts.length + index
    return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pageTexts.length * 2} 0 R >> >> /Contents ${contentNumber} 0 R >>`
  })
  const contentObjects = pageTexts.map((text) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageTexts.length} >>`,
    ...pageObjects,
    ...contentObjects,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
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
