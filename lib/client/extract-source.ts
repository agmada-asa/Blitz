/** Extracts browser-selected and fetched source files into text before upload. */

/** Source formats supported by upload and paste ingestion. */
export type SourceKind = "pdf" | "markdown" | "text" | "paste"

/** Maximum compressed PowerPoint bytes read by the browser extractor. */
export const MAX_POWERPOINT_COMPRESSED_BYTES = 20_000_000
/** Maximum declared uncompressed bytes accepted across a PowerPoint archive. */
export const MAX_POWERPOINT_UNCOMPRESSED_BYTES = 50_000_000
/** Maximum declared uncompressed bytes accepted for one PowerPoint entry. */
export const MAX_POWERPOINT_ENTRY_BYTES = 5_000_000

/** Returns whether a selected file uses one of Blitz's supported extensions. */
export function isSupportedSourceFilename(filename: string): boolean {
  const extension = filename.toLowerCase().split(".").pop()
  return (
    extension === "pdf" ||
    extension === "md" ||
    extension === "markdown" ||
    extension === "txt" ||
    extension === "pptx"
  )
}

/** Extracts slide text from a bounded PowerPoint ZIP using the installed fflate decoder. */
export async function extractPowerPointText(file: File): Promise<string> {
  if (file.size > MAX_POWERPOINT_COMPRESSED_BYTES) {
    throw new Error("That PowerPoint file is too large to import.")
  }
  const { strFromU8, unzipSync } = await import("fflate")
  const data = new Uint8Array(await file.arrayBuffer())
  let declaredUncompressedBytes = 0
  const archive = unzipSync(data, {
    filter: (entry) => {
      if (
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        entry.originalSize > MAX_POWERPOINT_ENTRY_BYTES
      ) {
        throw new Error("That PowerPoint archive contains an oversized entry.")
      }
      declaredUncompressedBytes += entry.originalSize
      if (declaredUncompressedBytes > MAX_POWERPOINT_UNCOMPRESSED_BYTES) {
        throw new Error(
          "That PowerPoint archive expands beyond the import limit."
        )
      }
      return /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)
    },
  })
  const slideNames = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      const rightNumber = Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
      return leftNumber - rightNumber
    })
  const slides = slideNames.flatMap((name) => {
    const slideNumber = Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0)
    const xml = strFromU8(archive[name]!)
    const parsed = new DOMParser().parseFromString(xml, "application/xml")
    if (parsed.querySelector("parsererror")) return []
    const textNodes = Array.from(
      parsed.getElementsByTagNameNS(
        "http://schemas.openxmlformats.org/drawingml/2006/main",
        "t"
      )
    )
    const text = textNodes
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    return text ? [`[Slide ${slideNumber}]\n${text}`] : []
  })
  if (!slides.length)
    throw new Error("There was no readable text in that PowerPoint file.")
  return slides.join("\n\n")
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

/** Derives a readable filename from a URL path without retaining query strings. */
function filenameForSourceUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl)
    const segment = url.pathname.split("/").filter(Boolean).pop()
    if (segment) {
      const decoded = decodeURIComponent(segment).trim()
      if (decoded) return decoded.slice(0, 255)
    }
    return `${url.hostname} source`.slice(0, 255)
  } catch {
    return "Imported source"
  }
}

/** Collects visible HTML text while adding line breaks between block elements. */
function collectHtmlText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const element = node as Element
  if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) {
    return ""
  }
  const text = Array.from(element.childNodes)
    .map((child) => collectHtmlText(child))
    .join("")
  return [
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BR",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TD",
    "TH",
    "TR",
    "UL",
  ].includes(element.tagName)
    ? `${text}\n`
    : text
}

/** Extracts readable main or article text from HTML using the browser's DOM parser. */
export function extractHtmlText(html: string): string {
  if (!html.trim()) return ""
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const root =
    parsed.querySelector("main, article, [role='main']") ?? parsed.body
  if (!root) return ""
  root
    .querySelectorAll("script, style, noscript, template, nav, aside")
    .forEach((element) => element.remove())
  return collectHtmlText(root)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Extracts a same-origin route response into the source shape used by persistence. */
export async function extractSourceResponse(
  response: Response,
  sourceUrl: string
): Promise<{
  filename: string
  kind: Exclude<SourceKind, "paste">
  text: string
}> {
  if (!response.ok) throw new Error("That source could not be fetched.")
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() ?? ""
  let filename = filenameForSourceUrl(sourceUrl)
  if (contentType === "application/pdf" && !/\.pdf$/i.test(filename))
    filename = `${filename}.pdf`
  if (
    (contentType === "text/markdown" || contentType === "text/x-markdown") &&
    !/\.(md|markdown)$/i.test(filename)
  )
    filename = `${filename}.md`
  const isPowerPoint =
    contentType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.pptx$/i.test(filename)
  if (isPowerPoint && !/\.pptx$/i.test(filename)) filename = `${filename}.pptx`
  if (contentType === "application/pdf") {
    const file = new File([await response.arrayBuffer()], filename, {
      type: contentType,
    })
    const source = await extractSource(file)
    return { filename: source.filename, kind: source.kind, text: source.text }
  }
  if (isPowerPoint) {
    const file = new File([await response.arrayBuffer()], filename, {
      type: contentType,
    })
    const source = await extractSource(file)
    return { filename: source.filename, kind: source.kind, text: source.text }
  }
  const rawText = await response.text()
  const text =
    contentType === "text/html" ? extractHtmlText(rawText) : rawText.trim()
  return { filename, kind: kindForFilename(filename), text }
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
    throw new Error("Choose a PDF, Markdown, text, or PowerPoint file.")
  }
  if (/\.pptx$/i.test(file.name)) {
    return {
      filename: file.name,
      kind: "text" as const,
      text: (await extractPowerPointText(file)).trim(),
    }
  }
  const kind = kindForFilename(file.name)
  const text = kind === "pdf" ? await extractPdfText(file) : await file.text()
  return { filename: file.name, kind, text: text.trim() }
}
