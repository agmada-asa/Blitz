/** Cuts growing Markdown into speakable pieces without consuming unfinished structured blocks. */

/** Longest piece sent to synthesis; longer sentences are split at their clearest clause break. */
export const SPEECH_PIECE_CHARS = 360

/**
 * Finds the end of the next whole sentence or paragraph; returns -1 while more text is needed.
 * Pieces end only at sentence boundaries, because a cut mid-sentence makes the voice restart
 * its intonation and sound like it jumps. The first piece is no exception: a short sentence
 * synthesizes quickly enough that clause cuts buy little.
 */
export function pieceEnd(text: string): number {
  let fence = false
  let math = false
  let offset = 0
  for (const line of text.split("\n")) {
    const structured = fence || math || /^\s*(?:\x60{3}|~{3}|\|)/.test(line) || line.includes("$$")
    if (/^\s*(?:\x60{3}|~{3})/.test(line)) fence = !fence
    if ((line.match(/\$\$/g)?.length ?? 0) % 2) math = !math
    if (!structured) {
      // A full stop after a lone letter or digit ("e.g.", "1.", "U.K.") rarely ends a sentence.
      for (const match of line.matchAll(/(?<![\s(][A-Za-z0-9]|\be\.g|\bi\.e)[.!?]["')\]]*\s/g)) {
        const end = offset + match.index! + match[0].length
        // Inline math is held until its closing delimiter arrives.
        const prefix = text.slice(0, end)
        if (end >= 12 && (prefix.match(/(?<!\\)\$(?!\$)/g)?.length ?? 0) % 2 === 0) return end
      }
    }
    offset += line.length + 1
    if (!fence && !math && offset <= text.length && line === "") return offset
  }
  return -1
}

/**
 * Splits one spoken sentence or paragraph into synthesis-sized pieces, preferring sentence ends,
 * then clause breaks, then commas, and a word boundary only as a last resort.
 */
export function speakablePieces(text: string, limit = SPEECH_PIECE_CHARS): string[] {
  const pieces: string[] = []
  let remaining = text.trim()
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit)
    let cut = 0
    for (const pattern of [/[.!?]["')\]]*\s+/g, /[;:]\s+|\s[–—]\s/g, /,\s+/g]) {
      const last = [...window.matchAll(pattern)].at(-1)
      // A break in the first third would leave a fragment too short to sound natural.
      if (last && last.index! + last[0].length >= limit / 3) { cut = last.index! + last[0].length; break }
    }
    if (!cut) cut = window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") + 1 : limit
    pieces.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) pieces.push(remaining)
  return pieces
}
