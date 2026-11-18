/**
 * Decides how the source reader shows a cited original, and finds the cited
 * passage inside a rendered original.
 *
 * The reader always has the extracted text (the Passage view). When the
 * original file is kept and Blitz can draw it, it also gets a view of the
 * original: PDF pages, PowerPoint slides, a Word document, or formatted
 * Markdown. Each view opens at the cited place and highlights the passage,
 * using {@link quoteMatchSpans} to line the saved passage up with the text
 * the view drew. Everything here is pure so it can be tested without a DOM.
 */

/** A view of the original that the source reader can draw. */
export type OriginalViewer = "pdf" | "slides" | "document" | "markdown"

/** Media type of PowerPoint presentations (`.pptx`). */
export const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"

/** Media type of Word documents (`.docx`). */
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Longest Markdown text drawn as a formatted document; longer text keeps the Passage view only. */
export const MAX_FORMATTED_MARKDOWN_CHARACTERS = 400_000

/** What the reader knows about a cited source when picking a view. */
export type OriginalViewerInput = {
  /** Media type saved with the source or attachment, possibly with parameters. */
  mimeType?: string
  /** User-visible filename, used when the media type is missing or generic. */
  filename: string
  /** Route serving the saved original, when one was kept. */
  fileUrl?: string
  /** Length of the extracted text, which bounds the formatted Markdown view. */
  textLength: number
}

/**
 * Picks the view of the original for a cited source, or undefined when only
 * the extracted passage can be shown.
 *
 * - PDF, PowerPoint and Word views need the saved original file.
 * - Markdown is drawn from the extracted text, so it works for pasted notes
 *   too, and for Word documents whose original was not kept (Word is
 *   extracted as Markdown).
 */
export function originalViewer(
  input: OriginalViewerInput
): OriginalViewer | undefined {
  const mimeType = input.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? ""
  const extension = /\.([a-z0-9]+)$/i.exec(input.filename)?.[1]?.toLowerCase()
  const isPdf = mimeType === "application/pdf" || extension === "pdf"
  const isPptx = mimeType === PPTX_MIME_TYPE || extension === "pptx"
  const isDocx = mimeType === DOCX_MIME_TYPE || extension === "docx"
  if (input.fileUrl) {
    if (isPdf) return "pdf"
    if (isPptx) return "slides"
    if (isDocx) return "document"
  }
  const isMarkdown =
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown" ||
    extension === "md" ||
    extension === "markdown" ||
    isDocx
  if (isMarkdown && input.textLength <= MAX_FORMATTED_MARKDOWN_CHARACTERS)
    return "markdown"
  return undefined
}

/** Tab label for each view of the original, in the reader's wording. */
export const ORIGINAL_VIEWER_LABELS: Record<OriginalViewer, string> = {
  pdf: "Original PDF",
  slides: "Slides",
  document: "Document",
  markdown: "Formatted",
}

/**
 * Returns the slide a citation points at, from its `Slide N` label or the
 * `[Slide N]` marker that starts its passage; undefined when neither is there.
 */
export function citedSlide(citation: {
  label: string
  text: string
}): number | undefined {
  const value =
    /^\s*Slide\s+(\d+)\b/i.exec(citation.label)?.[1] ??
    /^\s*\[Slide\s+(\d+)\]/i.exec(citation.text)?.[1]
  const slide = value ? Number(value) : undefined
  return slide && Number.isSafeInteger(slide) ? slide : undefined
}

/**
 * Characters ignored when comparing a saved passage with a drawn original:
 * whitespace, and the Markdown syntax extraction writes but a rendered page
 * shows as formatting (`#` headings, `*`/`_` emphasis, `` ` `` code, `>`
 * quotes, `|` table cells, `-` list items and rules), and zero-width
 * characters that renderers use to hold open empty lines.
 */
const IGNORED_CHARACTER = /[\s#*_`>|~​-‍﻿-]/u

/** Shortest piece of a passage, once compacted, that is matched on its own. */
const MIN_FRAGMENT_CHARACTERS = 16

/** A highlighted run of characters inside one drawn text piece. */
export type QuoteSpan = {
  /** Index of the text piece in the list passed to {@link quoteMatchSpans}. */
  index: number
  /** Inclusive start offset within that piece. */
  start: number
  /** Exclusive end offset within that piece. */
  end: number
}

/**
 * Finds where a saved passage appears in the text a view has drawn.
 *
 * Views draw text in many small pieces (DOM text nodes), with spacing,
 * Markdown syntax and list markers that differ from the extracted passage.
 * Matching therefore ignores whitespace, case and {@link IGNORED_CHARACTER}.
 * When the whole passage is not found, each sentence or line of it (less any
 * bracketed aside) is matched on its own, in order, so a table, a numbered
 * list or a footnote only loses that piece.
 *
 * @param pieces Drawn text pieces, in reading order.
 * @param quote The cited passage, possibly starting with a `[Page N]`,
 *   `[Slide N]` or `[m:ss]` marker added by extraction.
 * @returns One span per piece touched by a match, in reading order; empty
 *   when nothing matched.
 */
export function quoteMatchSpans(
  pieces: readonly string[],
  quote: string
): QuoteSpan[] {
  // Compact every piece into one string, remembering where each character came
  // from. Characters are lower-cased one at a time on both sides: some grow
  // (`İ` becomes two code units) and some depend on their neighbours (final
  // `Σ`), so whole-string lower-casing would misalign the two.
  let haystack = ""
  const owners: Array<{ index: number; offset: number }> = []
  pieces.forEach((piece, index) => {
    for (let offset = 0; offset < piece.length; offset++) {
      const character = piece[offset]
      if (IGNORED_CHARACTER.test(character)) continue
      const folded = character.toLowerCase()
      haystack += folded
      for (let unit = 0; unit < folded.length; unit++)
        owners.push({ index, offset })
    }
  })
  const compact = (value: string) =>
    [...value]
      .filter((character) => !IGNORED_CHARACTER.test(character))
      .map((character) => character.toLowerCase())
      .join("")
  const body = quote.replace(
    /^\s*\[(?:Page|Slide|Part)\s+[^\]\n]+\]\s*|^\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s*/i,
    ""
  )
  const matched = new Set<number>()
  /** Marks the first occurrence of `needle` after `from`; returns its end, or -1. */
  const mark = (needle: string, from: number) => {
    const start = needle ? haystack.indexOf(needle, from) : -1
    if (start < 0) return -1
    for (let position = start; position < start + needle.length; position++)
      matched.add(position)
    return start + needle.length
  }
  if (mark(compact(body), 0) < 0) {
    // Fragments are matched in order, so a repeated phrase earlier in the
    // document is not picked over the one next to the rest of the passage.
    let cursor = 0
    let first = true
    // Bracketed asides (`[image]`, `(see p. 4)`) often exist only on one side.
    for (const fragment of body.split(
      /(?<=[.!?;:])\s+|\n+|\s*\[[^\]\n]*\]\s*|\s*\([^)\n]*\)\s*/
    )) {
      const needle = compact(fragment)
      if (needle.length < MIN_FRAGMENT_CHARACTERS) continue
      const end = mark(needle, first ? 0 : cursor)
      if (end >= 0) {
        cursor = end
        first = false
      }
    }
  }
  // Turn matched characters back into contiguous runs per piece.
  const spans: QuoteSpan[] = []
  for (const position of [...matched].sort((a, b) => a - b)) {
    const { index, offset } = owners[position]
    const last = spans.at(-1)
    if (
      last &&
      last.index === index &&
      [...pieces[index].slice(last.end, offset)].every((character) =>
        IGNORED_CHARACTER.test(character)
      )
    ) {
      // Ignored characters between matches (spaces, list dashes) join the same run.
      last.end = offset + 1
    } else spans.push({ index, start: offset, end: offset + 1 })
  }
  return spans
}

/**
 * Converts a transcript timestamp label (`m:ss` or `h:mm:ss`) to seconds;
 * undefined for any other label.
 */
export function timestampSeconds(label: string): number | undefined {
  const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(label)
  if (!match) return undefined
  const [, hours, minutes, seconds] = match
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * Adds a start time to a YouTube link so a transcript citation plays from the
 * cited moment. Returns undefined for other sites, whose players do not share
 * a start-time parameter.
 */
export function youtubeAtTime(url: string, seconds: number): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const host = parsed.hostname.replace(/^(?:www|m)\./, "")
  if (host !== "youtube.com" && host !== "youtu.be") return undefined
  parsed.searchParams.set("t", `${seconds}s`)
  return parsed.toString()
}
