/**
 * How a module's source files are named and described in lists. Stored
 * filenames are kept as they are; these helpers only shape what the learner
 * reads, so a file stays easy to recognise in the Sources list and on its own
 * page. Everything here is pure so it can be tested without a DOM.
 */

/**
 * A content hash some downloads put in front of the real name, such as
 * `fcbd31…9ae-Brooks 1986 - No Silver Bullet.pdf`. Matches 32 to 64 hex
 * characters followed by a hyphen, and only when a name follows.
 */
const HASH_PREFIX = /^[0-9a-f]{32,64}-(?=\S)/i

/**
 * Returns the name to show for a stored filename: the same name without a
 * leading content hash. A name that is only a hash is returned unchanged.
 */
export function sourceDisplayName(filename: string): string {
  return filename.replace(HASH_PREFIX, "")
}

/** What a list needs to know about a source to describe its type. */
export type SourceTypeInput = {
  filename: string
  mimeType?: string
  /** The extraction kind Blitz stored for the source. */
  kind?: "pdf" | "markdown" | "text" | "paste"
  /** Present for sources added as a link. */
  originalUrl?: string
  /** Present when the original file is kept. */
  relativeKey?: string
}

/**
 * Names a source's type in a word or two: "PDF", "Slides", "Word document",
 * "Web page", "Markdown", "Text", "Pasted text" or "Link". The file's own
 * extension wins over the extraction kind, because slides and web pages are
 * stored as extracted text but the learner knows them by what they are.
 * Returns undefined when nothing identifies the type.
 */
export function sourceTypeLabel(source: SourceTypeInput): string | undefined {
  if (source.originalUrl && !source.relativeKey) return "Link"
  const extension = /\.([a-z0-9]+)$/i.exec(source.filename)?.[1]?.toLowerCase()
  const mimeType = source.mimeType?.split(";", 1)[0].trim().toLowerCase() ?? ""
  if (extension === "pdf" || mimeType === "application/pdf") return "PDF"
  if (extension === "pptx" || extension === "ppt") return "Slides"
  if (extension === "docx" || extension === "doc") return "Word document"
  if (extension === "html" || extension === "htm" || mimeType === "text/html") return "Web page"
  if (extension === "md" || extension === "markdown" || source.kind === "markdown")
    return "Markdown"
  if (source.kind === "paste") return "Pasted text"
  if (extension === "txt" || source.kind === "text") return "Text"
  if (source.kind === "pdf") return "PDF"
  return undefined
}
