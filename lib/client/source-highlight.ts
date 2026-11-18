/**
 * Highlights a cited passage inside an original the source reader has drawn
 * (slides, a Word document, formatted Markdown) and scrolls to it.
 *
 * The passage is located with `quoteMatchSpans` from `lib/source-viewers.ts`
 * and painted through the CSS Custom Highlight API, so the drawn markup is
 * never changed. Browsers without that API still scroll to the passage.
 */

import { quoteMatchSpans } from "../source-viewers.ts"

/** Name of the highlight styled by `::highlight(source-quote)` in `app/globals.css`. */
const HIGHLIGHT_NAME = "source-quote"

/** Reports whether this browser can paint named highlights. */
function canHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  )
}

/**
 * Highlights `quote` within `root`, skipping text in elements marked
 * `data-quote-ignore` (slide numbers and other reader furniture).
 *
 * @param root The element holding the drawn original.
 * @param quote The cited passage as saved with the citation.
 * @returns The first highlighted range, for scrolling; null when the passage
 *   was not found, in which case any earlier highlight is cleared.
 */
export function highlightQuote(root: HTMLElement, quote: string): Range | null {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[data-quote-ignore], style, script")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text)
  const spans = quoteMatchSpans(
    nodes.map((node) => node.data),
    quote
  )
  const ranges = spans.map((span) => {
    const range = document.createRange()
    range.setStart(nodes[span.index], span.start)
    range.setEnd(nodes[span.index], span.end)
    return range
  })
  if (canHighlight()) {
    if (ranges.length) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    else CSS.highlights.delete(HIGHLIGHT_NAME)
  }
  return ranges[0] ?? null
}

/** Removes the passage highlight, for example when the reader closes. */
export function clearQuoteHighlight(): void {
  if (canHighlight()) CSS.highlights.delete(HIGHLIGHT_NAME)
}

/**
 * Scrolls the nearest scrolling ancestor so a range sits in the middle of it.
 * Only that ancestor moves, so a reader beside the chat never scrolls the page.
 */
export function scrollRangeIntoView(range: Range, scroller: HTMLElement): void {
  const target = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  scroller.scrollTop +=
    target.top - box.top - (box.height - Math.min(target.height, box.height)) / 2
}
