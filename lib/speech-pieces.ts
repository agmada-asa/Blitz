/** Cuts growing Markdown into speakable pieces without consuming unfinished structured blocks. */

/** Finds a safe sentence or opening clause boundary; returns -1 while more text is needed. */
export function pieceEnd(text: string, first = false): number {
  let fence = false
  let math = false
  let offset = 0
  for (const line of text.split("\n")) {
    const structured = fence || math || /^\s*(?:\x60{3}|~{3}|\|)/.test(line) || line.includes("$$")
    if (/^\s*(?:\x60{3}|~{3})/.test(line)) fence = !fence
    if ((line.match(/\$\$/g)?.length ?? 0) % 2) math = !math
    if (!structured) {
      const boundary = first ? /[.!?]["')\]]*\s|[,;:]\s/g : /[.!?]["')\]]*\s/g
      for (const match of line.matchAll(boundary)) {
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
