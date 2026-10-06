/** Shares Markdown parsing and safe external-link policy between web and native chat. */
import { lexer, Marked, type Token, type TokenizerExtension } from "marked"
import { decodeHTML } from "entities"

/** A formula whose delimiters are preserved in raw for source copying and fallback rendering. */
export type MathToken = {
  type: "math"
  raw: string
  text: string
  display: boolean
}

/** Recognizes complete formulas before Markdown consumes backslashes or emphasis characters. */
function mathToken(source: string, block: boolean): MathToken | undefined {
  const rules = block
    ? [
        /^ {0,3}\$\$((?:\\.|[^\\])*?)\$\$(?:[ \t]*(?:\n|$))/,
        /^ {0,3}\\\[([\s\S]*?)\\\](?:[ \t]*(?:\n|$))/,
      ]
    : [
        /^\$\$((?:\\.|[^\\])*?)\$\$/,
        /^\\\[([\s\S]*?)\\\]/,
        /^\\\(([^\n]*?)\\\)/,
        /^\$((?:\\.|[^\\$\n])+?)\$(?!\d)/,
      ]

  for (const [index, rule] of rules.entries()) {
    const match = rule.exec(source)
    if (!match || !match[1].trim()) continue
    // Single dollars follow math spacing rules so ordinary prices remain prose.
    if (!block && index === 3 && /^\s|\s$/.test(match[1])) continue
    return {
      type: "math",
      raw: match[0],
      text: match[1].trim(),
      display: block || index < 2,
    }
  }
}

/** Builds a tokenizer at either Markdown level without changing code spans or fenced source. */
function mathExtension(level: "block" | "inline"): TokenizerExtension {
  return {
    name: "math",
    level,
    /** Stops text consumption at a possible formula; escaped openers stay handled by Marked. */
    start(source) {
      return level === "block"
        ? source.match(/(?:^|\n) {0,3}(?:\$\$|\\\[)/)?.index
        : source.match(/\$|\\[([]/)?.index
    },
    /** Emits only complete formulas, leaving unfinished streamed input as literal Markdown. */
    tokenizer(source) {
      return mathToken(source, level === "block")
    },
  }
}

/** Private parser keeps formula extensions isolated from other Marked consumers. */
const markdownParser = new Marked(
  { gfm: true, breaks: true },
  {
    extensions: [mathExtension("block"), mathExtension("inline")],
  }
)

/** Tokenizes GFM; web renderers opt into formulas while native and speech consumers retain plain tokens. */
export function parseMarkdown(
  text: string,
  options: { math?: boolean } = {}
): Token[] {
  return options.math
    ? markdownParser.lexer(text)
    : lexer(text, { gfm: true, breaks: true })
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
