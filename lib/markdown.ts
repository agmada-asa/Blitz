/** Shares Markdown parsing and safe external-link policy between web and native chat. */
import { lexer, type Token } from "marked"
import { decodeHTML } from "entities"

/** Tokenizes complete or unfinished replies as GFM; renderers never execute raw HTML. */
export function parseMarkdown(text: string): Token[] {
  return lexer(text, { gfm: true, breaks: true })
}

/** Decodes Markdown entities as literal text, never as markup. */
export function markdownText(text: string): string {
  return decodeHTML(text)
}

/** Allows explicit web and email links; blocks scripts, local files, and app intents. */
export function markdownHref(value: string): string | undefined {
  const href = decodeHTML(value).trim()
  if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020]/.test(href))
    return undefined
  try {
    const url = new URL(href)
    if (url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Allows only remote HTTP(S) image sources, excluding credentials and control characters. */
export function markdownImageSrc(value: string): string | undefined {
  const href = decodeHTML(value).trim()
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020]/.test(href))
    return undefined
  try {
    const url = new URL(href)
    if (url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}
