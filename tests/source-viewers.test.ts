/**
 * Checks which view of an original the source reader offers, how a citation
 * finds its slide, how a saved passage is located in drawn text, and how
 * transcript citations open YouTube at the cited moment.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { citationOriginalUrl } from "../lib/citations.ts"
import {
  citedSlide,
  DOCX_MIME_TYPE,
  MAX_FORMATTED_MARKDOWN_CHARACTERS,
  originalViewer,
  PPTX_MIME_TYPE,
  quoteMatchSpans,
  timestampSeconds,
  youtubeAtTime,
} from "../lib/source-viewers.ts"

/** Joins the highlighted characters of each span, for readable assertions. */
function highlighted(pieces: string[], quote: string): string[] {
  return quoteMatchSpans(pieces, quote).map((span) =>
    pieces[span.index].slice(span.start, span.end)
  )
}

test("originals that need a saved file get a view only when it was kept", () => {
  const file = "/api/sources/file?inline=1"
  const base = { textLength: 100 }
  assert.equal(
    originalViewer({ ...base, mimeType: "application/pdf", filename: "a.pdf", fileUrl: file }),
    "pdf"
  )
  assert.equal(
    originalViewer({ ...base, mimeType: PPTX_MIME_TYPE, filename: "w1.pptx", fileUrl: file }),
    "slides"
  )
  assert.equal(
    originalViewer({ ...base, mimeType: DOCX_MIME_TYPE, filename: "notes.docx", fileUrl: file }),
    "document"
  )
  assert.equal(
    originalViewer({ ...base, mimeType: PPTX_MIME_TYPE, filename: "w1.pptx" }),
    undefined
  )
  // Word is extracted as Markdown, so without the file it is still formatted.
  assert.equal(
    originalViewer({ ...base, mimeType: DOCX_MIME_TYPE, filename: "notes.docx" }),
    "markdown"
  )
})

test("file extensions stand in for a missing or generic media type", () => {
  const fileUrl = "/f"
  assert.equal(
    originalViewer({ filename: "Lecture 3.PPTX", fileUrl, textLength: 1, mimeType: "text/plain" }),
    "slides"
  )
  assert.equal(originalViewer({ filename: "book.pdf", fileUrl, textLength: 1 }), "pdf")
  assert.equal(
    originalViewer({ filename: "notes.md", mimeType: "text/markdown; charset=utf-8", textLength: 10 }),
    "markdown"
  )
  assert.equal(
    originalViewer({ filename: "transcript.txt", mimeType: "text/plain", fileUrl, textLength: 10 }),
    undefined
  )
  assert.equal(
    originalViewer({
      filename: "huge.md",
      mimeType: "text/markdown",
      textLength: MAX_FORMATTED_MARKDOWN_CHARACTERS + 1,
    }),
    undefined
  )
})

test("a citation finds its slide from the label or the passage marker", () => {
  assert.equal(citedSlide({ label: "Slide 12", text: "Recursion" }), 12)
  assert.equal(citedSlide({ label: "Section 2", text: "[Slide 4]\nTrees" }), 4)
  assert.equal(citedSlide({ label: "Page 4", text: "[Page 4]\nTrees" }), undefined)
})

test("passages match drawn text across pieces, spacing and Markdown syntax", () => {
  const pieces = ["Intro", "Binary search ", "halves the range", " each step."]
  assert.deepEqual(
    highlighted(pieces, "[Slide 3]\nBinary   search halves the range each step."),
    ["Binary search", "halves the range", "each step."]
  )
  // Headings, emphasis and list dashes are formatting once drawn.
  assert.deepEqual(
    highlighted(["Big O", "It bounds growth from above."], "## Big O\n\n- It **bounds** growth from above."),
    ["Big O", "It bounds growth from above."]
  )
})

test("a passage that differs in one part still highlights the parts that match", () => {
  const pieces = [
    "A heap keeps the smallest key at the root.",
    "Figure 2",
    "Insertion sifts the new key up until order holds again.",
  ]
  assert.deepEqual(
    highlighted(
      pieces,
      "A heap keeps the smallest key at the root. [image] Insertion sifts the new key up until order holds again."
    ),
    [pieces[0], pieces[2]]
  )
  assert.deepEqual(quoteMatchSpans(pieces, "Nothing here matches at all, honestly."), [])
})

test("fragments are matched in order so a repeated phrase earlier is skipped", () => {
  const pieces = [
    "Stacks are last in, first out.",
    "Queues are first in, first out.",
    "Stacks are last in, first out.",
    "Push adds to the top of the stack.",
  ]
  const spans = quoteMatchSpans(
    pieces,
    "Queues are first in, first out. (see p. 4) Stacks are last in, first out."
  )
  assert.deepEqual(
    spans.map((span) => span.index),
    [1, 2]
  )
})

test("transcript citations open YouTube at the cited moment", () => {
  assert.equal(timestampSeconds("12:34"), 754)
  assert.equal(timestampSeconds("1:02:03"), 3723)
  assert.equal(timestampSeconds("Slide 2"), undefined)
  assert.equal(
    youtubeAtTime("https://www.youtube.com/watch?v=abc", 90),
    "https://www.youtube.com/watch?v=abc&t=90s"
  )
  assert.equal(youtubeAtTime("https://youtu.be/abc?t=5", 7), "https://youtu.be/abc?t=7s")
  assert.equal(youtubeAtTime("https://example.com/video", 7), undefined)
  assert.equal(
    citationOriginalUrl(
      { label: "2:05", text: "[2:05] So a heap" },
      { webUrl: "https://www.youtube.com/watch?v=abc" }
    ),
    "https://www.youtube.com/watch?v=abc&t=125s"
  )
  // Other sites keep the text fragment.
  assert.match(
    citationOriginalUrl(
      { label: "2:05", text: "[2:05] So a heap" },
      { webUrl: "https://example.com/talk" }
    ) ?? "",
    /#:~:text=So%20a%20heap$/
  )
})
