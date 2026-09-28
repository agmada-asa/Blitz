/**
 * Scores how well extraction and sectioning preserve a source for generation.
 *
 * The functions are pure so the ingestion eval can score today's fixed-size
 * chunks and later structure-aware sections with the same definitions. They
 * never return source text, only counts and ratios.
 */

/** One generation section located by offsets in its normalized document. */
export interface MeasuredSection {
  /** Exact section text. */
  text: string
  /** Inclusive start offset in the normalized document. */
  startOffset: number
  /** Exclusive end offset in the normalized document. */
  endOffset: number
  /** Heading path or other structural title, when sectioning found one. */
  title?: string
}

/** Page text density measured from explicit `[Page N]` markers. */
export interface PageDensity {
  /** Number of `[Page N]` markers in the document. */
  pageCount: number
  /** Pages whose text is shorter than {@link LOW_TEXT_PAGE_CHARACTERS}. */
  lowTextPageCount: number
  /** Median characters of text per page, excluding the marker itself. */
  medianCharactersPerPage: number
}

/** Size and boundary quality of a document's sections. */
export interface SectionQuality {
  /** Number of sections. */
  sectionCount: number
  /** 10th, 50th and 90th percentile section length in characters. */
  sizePercentiles: { p10: number; p50: number; p90: number }
  /** Longest section in characters. */
  largestSection: number
  /** Characters that appear in more than one section because of overlap. */
  duplicatedCharacters: number
  /** Share of the document's characters repeated by overlap, from 0 to 1. */
  duplicatedShare: number
  /** Share of section ends, excluding the last, that cut through a sentence. */
  midSentenceEndShare: number
  /** Share of sections with a structural title. */
  titledShare: number
}

/**
 * Pages with less text than this are likely figures, diagrams, equations or
 * scans, where text extraction alone loses teaching content.
 */
export const LOW_TEXT_PAGE_CHARACTERS = 150

/** Matches a `[Page N]` marker at the start of a line. */
const PAGE_MARKER = /^\[Page \d+\]$/gm

/**
 * Measures how much text each page contributes.
 *
 * @param text Normalized document text.
 * @returns Page counts and density. Documents without page markers report
 *   zero pages.
 */
export function measurePageDensity(text: string): PageDensity {
  const starts = [...text.matchAll(PAGE_MARKER)].map((match) => ({
    markerEnd: match.index + match[0].length,
    markerStart: match.index,
  }))
  const lengths = starts.map((page, index) =>
    text
      .slice(page.markerEnd, starts[index + 1]?.markerStart ?? text.length)
      .trim().length
  )
  return {
    pageCount: lengths.length,
    lowTextPageCount: lengths.filter(
      (length) => length < LOW_TEXT_PAGE_CHARACTERS
    ).length,
    medianCharactersPerPage: percentile(lengths, 0.5),
  }
}

/**
 * Measures section sizes, overlap and where boundaries fall.
 *
 * A section end is clean when it lands on a paragraph break or its trimmed
 * text ends with sentence punctuation. Anything else is counted as cutting
 * through a sentence, which can split a definition, proof or example.
 *
 * @param documentText Normalized text the sections were cut from.
 * @param sections Sections in document order.
 * @returns Quality measures. An empty section list returns zeros.
 */
export function measureSectionQuality(
  documentText: string,
  sections: readonly MeasuredSection[]
): SectionQuality {
  const lengths = sections.map((section) => section.text.length)
  let duplicatedCharacters = 0
  for (let index = 1; index < sections.length; index += 1)
    duplicatedCharacters += Math.max(
      0,
      sections[index - 1].endOffset - sections[index].startOffset
    )
  // The final section always ends at the document end, so it is not a cut.
  const interiorEnds = sections.slice(0, -1)
  const midSentenceEnds = interiorEnds.filter(
    (section) => !isCleanEnd(documentText, section)
  ).length
  return {
    sectionCount: sections.length,
    sizePercentiles: {
      p10: percentile(lengths, 0.1),
      p50: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
    },
    largestSection: Math.max(0, ...lengths),
    duplicatedCharacters,
    duplicatedShare: ratio(duplicatedCharacters, documentText.length),
    midSentenceEndShare: ratio(midSentenceEnds, interiorEnds.length),
    titledShare: ratio(
      sections.filter((section) => section.title?.trim()).length,
      sections.length
    ),
  }
}

/**
 * Reports whether a section ends at a paragraph break or sentence end.
 *
 * @param documentText Normalized document text.
 * @param section Section whose end offset is checked.
 * @returns True for a clean boundary.
 */
function isCleanEnd(documentText: string, section: MeasuredSection): boolean {
  const following = documentText.slice(section.endOffset, section.endOffset + 2)
  if (following.startsWith("\n\n") || section.text.endsWith("\n\n")) return true
  return /[.!?:;)\]"'”’]$/.test(section.text.trimEnd())
}

/**
 * Returns the nearest-rank percentile of a list of numbers.
 *
 * @param values Unsorted values.
 * @param fraction Percentile between 0 and 1.
 * @returns The percentile, or 0 for an empty list.
 */
function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  ]
}

/**
 * Divides safely and rounds to three decimal places for readable reports.
 *
 * @param part Numerator.
 * @param whole Denominator.
 * @returns The ratio, or 0 when the denominator is 0.
 */
function ratio(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 1000 : 0
}
