/** Verifies PDF position sorting before text reaches audiobook preparation. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  pdfPageReadingOrder,
  type PositionedPdfText,
} from "../lib/server/source-ingestion/pdf-reading-order.ts"

/** Makes one positioned text line in a 600 point wide test page. */
function item(
  str: string,
  x: number,
  y: number,
  width: number
): PositionedPdfText {
  return { str, transform: [1, 0, 0, 1, x, y], width }
}

test("reads two columns down the left before the right, despite content stream order", () => {
  const items = [
    item("Right third.", 332, 660, 185),
    item("Left second.", 70, 680, 185),
    item("Page title", 70, 740, 460),
    item("Right first.", 332, 700, 185),
    item("Left third.", 70, 660, 185),
    item("Right second.", 332, 680, 185),
    item("Left first.", 70, 700, 185),
    item("Page footer", 70, 610, 460),
  ]
  assert.equal(
    pdfPageReadingOrder(items, 600),
    "Page title\nLeft first.\nLeft second.\nLeft third.\nRight first.\nRight second.\nRight third.\nPage footer"
  )
})

test("keeps a single column in line order", () => {
  const items = [
    item("Second sentence.", 70, 680, 400),
    item("First sentence.", 70, 700, 400),
  ]
  assert.equal(
    pdfPageReadingOrder(items, 600),
    "First sentence.\nSecond sentence."
  )
})

test("reads three side-by-side slide panels one panel at a time", () => {
  const items = [
    item("02", 690, 670, 100),
    item("03", 1300, 670, 100),
    item("01", 85, 670, 100),
    item("Build", 680, 510, 400),
    item("Learn", 65, 510, 400),
    item("Practise", 1290, 510, 400),
    item("Second build line", 680, 440, 420),
    item("Second practice line", 1290, 440, 420),
    item("Second learn line", 65, 440, 420),
    item("Third practice line", 1290, 400, 420),
    item("Third learn line", 65, 400, 420),
    item("Third build line", 680, 400, 420),
    item("Last learn line", 65, 360, 420),
    item("Page number", 1850, 100, 50),
  ]
  assert.equal(
    pdfPageReadingOrder(items, 1920),
    "01\nLearn\nSecond learn line\nThird learn line\nLast learn line\n02\nBuild\nSecond build line\nThird build line\n03\nPractise\nSecond practice line\nThird practice line\nPage number"
  )
})
