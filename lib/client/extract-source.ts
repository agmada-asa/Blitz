/** Extracts browser-selected source files into text for the generation pipeline. */

/** Source formats supported by upload and paste ingestion. */
export type SourceKind = "pdf" | "markdown" | "text" | "paste"

/** Returns whether a selected file uses one of Blitz's supported extensions. */
export function isSupportedSourceFilename(filename: string): boolean {
  const extension = filename.toLowerCase().split(".").pop()
  return (
    extension === "pdf" ||
    extension === "md" ||
    extension === "markdown" ||
    extension === "txt"
  )
}

/** Maps a filename extension to the source kind used by persistence. */
export function kindForFilename(
  filename: string
): Exclude<SourceKind, "paste"> {
  const extension = filename.toLowerCase().split(".").pop()
  if (extension === "pdf") return "pdf"
  if (extension === "md" || extension === "markdown") return "markdown"
  return "text"
}

/** Extracts normalized text per PDF page and returns an empty string for image-only files. */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs")
  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({ data })
  const pdfDocument = await loadingTask.promise
  const pages: string[] = []

  try {
    for (
      let pageNumber = 1;
      pageNumber <= pdfDocument.numPages;
      pageNumber += 1
    ) {
      const page = await pdfDocument.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (text) pages.push(`[Page ${pageNumber}]\n${text}`)
    }
  } finally {
    await loadingTask.destroy()
  }

  return pages.join("\n\n")
}

/** Reads a supported file and returns its name, inferred kind, and trimmed text. */
export async function extractSource(file: File) {
  if (!isSupportedSourceFilename(file.name)) {
    throw new Error("Choose a PDF, Markdown, or text file.")
  }
  const kind = kindForFilename(file.name)
  const text = kind === "pdf" ? await extractPdfText(file) : await file.text()
  return { filename: file.name, kind, text: text.trim() }
}
