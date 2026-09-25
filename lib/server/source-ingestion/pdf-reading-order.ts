/** Reorders PDF text items by page position before source or audio preparation. */

/** Geometry and text supplied by pdfjs for one printable text item. */
export type PositionedPdfText = {
  /** Text extracted from one PDF item. */
  str: string
  /** PDF transform whose last two values locate the item's baseline. */
  transform: number[]
  /** Horizontal item width in page coordinates. */
  width: number
}

/** One horizontal run of words that belongs to a single page column. */
type Line = { x: number; right: number; y: number; text: string }

/** Joins text items on one line while preserving normal punctuation spacing. */
function lineText(items: PositionedPdfText[]): string {
  return items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
}

/** Joins positioned text lines in top-to-bottom reading order. */
export function pdfPageReadingOrder(
  items: readonly PositionedPdfText[],
  pageWidth: number
): string {
  const printable = items.filter(
    (item) =>
      item.str.trim() &&
      item.transform.length >= 6 &&
      Number.isFinite(item.transform[4]) &&
      Number.isFinite(item.transform[5]) &&
      Number.isFinite(item.width)
  )
  const rows: PositionedPdfText[][] = []
  for (const item of [...printable].sort(
    (a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]
  )) {
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate[0].transform[5] - item.transform[5]) <= 3
    )
    if (row) row.push(item)
    else rows.push([item])
  }

  const lines: Line[] = []
  const rowLines: Line[][] = []
  for (const row of rows) {
    row.sort((a, b) => a.transform[4] - b.transform[4])
    const currentRow: Line[] = []
    let run: PositionedPdfText[] = []
    let right = 0
    for (const item of row) {
      const x = item.transform[4]
      if (run.length && x - right > Math.max(24, pageWidth * 0.025)) {
        currentRow.push({
          x: run[0].transform[4],
          right,
          y: run[0].transform[5],
          text: lineText(run),
        })
        run = []
      }
      run.push(item)
      right = Math.max(right, x + Math.max(0, item.width))
    }
    if (run.length)
      currentRow.push({
        x: run[0].transform[4],
        right,
        y: run[0].transform[5],
        text: lineText(run),
      })
    lines.push(...currentRow)
    rowLines.push(currentRow)
  }

  const threeColumnRows = rowLines.filter(
    (row) =>
      row.length >= 3 &&
      row[1].x - row[0].right > pageWidth * 0.025 &&
      row[2].x - row[1].right > pageWidth * 0.025
  )
  const twoColumnRows = rowLines.filter(
    (row) => row.length >= 2 && row[1].x - row[0].right > pageWidth * 0.025
  )
  const columnRows =
    threeColumnRows.length >= 3
      ? threeColumnRows
      : twoColumnRows.length >= 3
        ? twoColumnRows
        : []
  if (!columnRows.length) return lines.map((line) => line.text).join("\n")

  const columnCount = columnRows === threeColumnRows ? 3 : 2
  const starts = columnRows[0].slice(0, columnCount).map((line) => line.x)
  const boundaries = starts
    .slice(1)
    .map((start, index) => (start + starts[index]) / 2)
  const columnYs = columnRows.map((row) => row[0].y)
  const top = Math.max(...columnYs)
  const bottom = Math.min(...columnYs)
  const sortedYs = [...columnYs].sort((a, b) => b - a)
  const gaps = sortedYs
    .slice(1)
    .map((y, index) => sortedYs[index] - y)
    .sort((a, b) => a - b)
  const typicalLineGap = gaps[Math.floor(gaps.length / 2)] ?? 0
  // A final line may exist in only one column, below the last paired row.
  const lowerBodyY = bottom - Math.max(24, typicalLineGap * 2)
  const before = lines.filter((line) => line.y > top + 3)
  const after = lines.filter((line) => line.y < lowerBodyY - 3)
  const body = lines.filter(
    (line) => line.y <= top + 3 && line.y >= lowerBodyY - 3
  )
  const columns = Array.from({ length: columnCount }, (_, column) =>
    body.filter((line) => {
      const position = boundaries.findIndex((boundary) => line.x < boundary)
      return (position < 0 ? columnCount - 1 : position) === column
    })
  )
  // Shared page titles and footers remain outside the column reading pass.
  return [...before, ...columns.flat(), ...after]
    .map((line) => line.text)
    .join("\n")
}
