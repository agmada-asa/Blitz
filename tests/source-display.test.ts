/**
 * Source names and type labels in the Sources list: content hashes in front
 * of downloaded names are hidden, and a file is described by what it is
 * (slides, a web page) rather than by how its text was extracted.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { sourceDisplayName, sourceTypeLabel } from "../lib/source-display.ts"

const HASH = "fcbd318dbaa31c5b14b782b02ae25f53fc8aa33779d18ba1b4f126994c99b9ae"

test("hides a content hash in front of a downloaded name", () => {
  assert.equal(
    sourceDisplayName(`${HASH}-Brooks 1986 - No Silver Bullet.pdf`),
    "Brooks 1986 - No Silver Bullet.pdf"
  )
})

test("leaves ordinary names alone", () => {
  assert.equal(sourceDisplayName("01.1.pptx"), "01.1.pptx")
  assert.equal(sourceDisplayName("1404520.1404522.pdf"), "1404520.1404522.pdf")
  assert.equal(sourceDisplayName("deadbeef-notes.txt"), "deadbeef-notes.txt")
})

test("keeps a name that is only a hash", () => {
  assert.equal(sourceDisplayName(`${HASH}-`), `${HASH}-`)
  assert.equal(sourceDisplayName(HASH), HASH)
})

test("names slides, web pages and documents by what they are", () => {
  assert.equal(sourceTypeLabel({ filename: "01.1.pptx", kind: "text" }), "Slides")
  assert.equal(sourceTypeLabel({ filename: "magic.html", kind: "text" }), "Web page")
  assert.equal(sourceTypeLabel({ filename: "notes.docx", kind: "markdown" }), "Word document")
  assert.equal(sourceTypeLabel({ filename: "paper.pdf", kind: "pdf" }), "PDF")
})

test("falls back to the extraction kind", () => {
  assert.equal(sourceTypeLabel({ filename: "Search.md", kind: "markdown" }), "Markdown")
  assert.equal(sourceTypeLabel({ filename: "W3 Reading.txt", kind: "text" }), "Text")
  assert.equal(sourceTypeLabel({ filename: "07.2.pptx.txt", kind: "text" }), "Text")
  assert.equal(sourceTypeLabel({ filename: "Pasted notes", kind: "paste" }), "Pasted text")
  assert.equal(sourceTypeLabel({ filename: "untitled" }), undefined)
})

test("calls a saved link a link only when no file was kept", () => {
  assert.equal(
    sourceTypeLabel({ filename: "page", originalUrl: "https://example.com" }),
    "Link"
  )
  assert.equal(
    sourceTypeLabel({
      filename: "page.html",
      originalUrl: "https://example.com",
      relativeKey: "sources/page.html",
    }),
    "Web page"
  )
})
