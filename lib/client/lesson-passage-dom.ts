/**
 * Reads quotable passages out of a rendered lesson: the sentence or component
 * at a point on screen, or a selection, as text with its maths written in TeX.
 * Also paints the highlight that shows which passage the Ask Blitz control
 * would quote, through the CSS Custom Highlight API, so the lesson's markup is
 * never changed. Browsers without that API simply show no highlight.
 */

import { normalizePassage, sentenceBoundsAt } from "../lesson-passage.ts"

/** A passage the learner can ask about, located in the lesson. */
export type LessonPassage = {
  /** The tutor reply holding the passage. */
  messageId: string
  /** The quote, with maths as TeX. */
  text: string
  /** Where the passage is, for highlighting it. */
  range: Range
  /** Vertical centre of the passage's line on screen, in viewport pixels. */
  lineCenter: number
}

/** Things quoted whole: a sentence of a table or a quiz would mean little. */
const COMPONENT_SELECTOR = [
  "[data-ask-block]",
  ".markdown-diagram",
  ".markdown-math-display",
  "pre",
  "table",
].join(", ")

/** Prose quoted one sentence at a time. */
const PROSE_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6"

/** Elements that end a line in a quote. */
const LINE_BREAK_SELECTOR =
  "p, li, tr, div, blockquote, h1, h2, h3, h4, h5, h6, pre, br"

/** One run of quote text and what it came from in the lesson. */
type TextPiece =
  | { kind: "text"; node: Text; start: number; length: number }
  | { kind: "math"; element: Element; start: number; length: number }

/** Reads the TeX source KaTeX keeps beside what it draws. */
function mathSource(element: Element): string {
  const source = element
    .querySelector('annotation[encoding="application/x-tex"]')
    ?.textContent?.trim()
  return source ? `$${source}$` : ""
}

/**
 * Flattens an element into quote text. Maths becomes TeX, because KaTeX's
 * drawn glyphs read as noise. Icon buttons and hidden text are left out.
 *
 * @param root The element to read.
 * @returns The text and which node each run of it came from.
 */
function readPieces(root: Node): { text: string; pieces: TextPiece[] } {
  let text = ""
  const pieces: TextPiece[] = []
  /** Appends one node and its descendants. */
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? ""
      if (value)
        pieces.push({ kind: "text", node: node as Text, start: text.length, length: value.length })
      text += value
      return
    }
    if (!(node instanceof Element)) {
      // A selection's copied fragment is not an element but holds them.
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) node.childNodes.forEach(visit)
      return
    }
    if (node.matches('button[aria-label], .sr-only, [aria-hidden="true"]')) return
    if (node.matches(".katex")) {
      const source = mathSource(node)
      pieces.push({ kind: "math", element: node, start: text.length, length: source.length })
      text += source
      return
    }
    node.childNodes.forEach(visit)
    if (node.matches("td, th") && node.nextElementSibling) text += " | "
    else if (node.matches(LINE_BREAK_SELECTOR)) text += "\n"
  }
  visit(root)
  return { text, pieces }
}

/** Returns the Range position of a caret on screen, in the browser's own form. */
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y)
    return position ? { node: position.offsetNode, offset: position.offset } : null
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** Turns a caret position into an offset in text read by {@link readPieces}. */
function textOffsetOf(pieces: TextPiece[], caret: { node: Node; offset: number }): number | null {
  for (const piece of pieces) {
    if (piece.kind === "text" && piece.node === caret.node) return piece.start + caret.offset
    if (piece.kind === "math" && piece.element.contains(caret.node)) return piece.start
  }
  return null
}

/** Builds the Range covering part of the text read by {@link readPieces}. */
function rangeOverText(pieces: TextPiece[], start: number, end: number): Range | null {
  const first = pieces.find((piece) => piece.length && start < piece.start + piece.length)
  const last = pieces.findLast((piece) => piece.length && end > piece.start)
  if (!first || !last) return null
  const range = document.createRange()
  if (first.kind === "text")
    range.setStart(first.node, Math.max(0, start - first.start))
  else range.setStartBefore(first.element)
  if (last.kind === "text")
    range.setEnd(last.node, Math.min(last.length, end - last.start))
  else range.setEndAfter(last.element)
  return range
}

/**
 * Finds the passage at a point: the whole component there, otherwise the
 * sentence of prose on that line.
 *
 * @param lesson The element holding the lesson; anything outside it is ignored.
 * @param x Horizontal position to read at, in viewport pixels.
 * @param y Vertical position to read at, in viewport pixels.
 * @returns The passage, or null over a gap or anything that isn't lesson text.
 */
export function passageAtPoint(lesson: Element, x: number, y: number): LessonPassage | null {
  const hit = document.elementFromPoint(x, y)
  if (!hit || !lesson.contains(hit)) return null
  const reply = hit.closest("[data-message-id]")
  const messageId = reply?.getAttribute("data-message-id")
  // A reply's own header holds the section number, title and read aloud.
  if (!reply || !messageId || hit.closest("header")) return null

  const component = hit.closest(COMPONENT_SELECTOR)
  if (component && reply.contains(component)) {
    const text = normalizePassage(
      component.getAttribute("data-ask-text") ?? readPieces(component).text
    )
    if (!text) return null
    const range = document.createRange()
    range.selectNodeContents(component)
    const box = component.getBoundingClientRect()
    // A tall component's control stays with the reader rather than off screen.
    return {
      messageId,
      text,
      range,
      lineCenter: box.height > 80 ? Math.max(box.top + 20, Math.min(y, box.bottom - 20)) : box.top + box.height / 2,
    }
  }

  const prose = hit.closest(PROSE_SELECTOR)
  if (!prose || !reply.contains(prose)) return null
  const { text, pieces } = readPieces(prose)
  const caret = caretAtPoint(x, y)
  const offset = caret ? textOffsetOf(pieces, caret) : null
  if (offset === null) return null
  const { start, end } = sentenceBoundsAt(text, offset)
  const quote = normalizePassage(text.slice(start, end))
  const range = rangeOverText(pieces, start, end)
  if (!quote || !range) return null
  // The line under the point, which a sentence's whole box can't tell us.
  const lineRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
  const line =
    lineRects.find((rect) => y >= rect.top && y <= rect.bottom) ?? lineRects[0]
  return {
    messageId,
    text: quote,
    range,
    lineCenter: line ? line.top + line.height / 2 : y,
  }
}

/**
 * Reads the learner's current selection when it lies within the lesson.
 *
 * @param lesson The element holding the lesson.
 * @returns The selected passage, or null with nothing quotable selected.
 */
export function selectedPassage(lesson: Element): LessonPassage | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  if (!start || !lesson.contains(start)) return null
  const messageId = start.closest("[data-message-id]")?.getAttribute("data-message-id")
  if (!messageId) return null
  const text = normalizePassage(readPieces(range.cloneContents()).text)
  if (text.length < 2) return null
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0)
  const last = rects.at(-1)
  return {
    messageId,
    text,
    range: range.cloneRange(),
    lineCenter: last ? last.top + last.height / 2 : 0,
  }
}

/** Name of the highlight in `app/globals.css`. */
const HIGHLIGHT_NAME = "lesson-ask"

/**
 * Shows which passage the side chat would quote, or clears it.
 *
 * @param range The passage to highlight, or null for none.
 */
export function setLessonHighlight(range: Range | null): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined")
    return
  if (range) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range))
  else CSS.highlights.delete(HIGHLIGHT_NAME)
}
