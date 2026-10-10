/**
 * Prepares Markdown replies and lessons for read aloud.
 *
 * The local speech model reads exactly the characters it receives, so Markdown structure and
 * written notation must become spoken English first. This module keeps headings, list items, and
 * paragraphs as separate sentences, speaks formulas through `spokenMath`, and rewrites currency and
 * symbols that the model would otherwise read literally, such as "£1" as "pound one". Code,
 * images, and interactive blocks stay silent, matching what a listener can follow without seeing them.
 */
import type { Token, Tokens } from "marked"

import { markdownText, parseMarkdown } from "./markdown.ts"
import { spokenAudioText } from "./spoken-audio.ts"
import { spokenMath } from "./spoken-math.ts"

/** Spoken unit names for each currency symbol: major singular, major plural, minor singular, minor plural. */
const CURRENCIES: Record<string, [string, string, string, string]> = {
  "£": ["pound", "pounds", "penny", "pence"],
  $: ["dollar", "dollars", "cent", "cents"],
  "€": ["euro", "euros", "cent", "cents"],
  "¥": ["yen", "yen", "sen", "sen"],
  "₹": ["rupee", "rupees", "paisa", "paise"],
}

/** Abbreviated amount scales, as in "£1.5m" or "$20bn". */
const SCALES: Record<string, string> = {
  k: "thousand",
  m: "million",
  bn: "billion",
  tn: "trillion",
}

/** Unicode superscript characters and the plain characters they raise. */
const SUPERSCRIPTS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
  ⁿ: "n",
}

/** Prose symbols the speech model skips or names literally, with the words a reader would say. */
const PROSE_SYMBOLS: [RegExp, string][] = [
  [/\s*(?:→|⟶|->)\s*/g, " to "],
  [/\s*(?:⇒|=>)\s*/g, " implies "],
  [/\s*⇔\s*/g, " if and only if "],
  [/\s+∈\s+/g, " is in "],
  [/\s+<\s+/g, " is less than "],
  [/\s+>\s+/g, " is greater than "],
  [/\s+<=\s+/g, " is less than or equal to "],
  [/\s+>=\s+/g, " is greater than or equal to "],
  [/\s+!=\s+/g, " is not equal to "],
  [/~\s?(?=\d)/g, "about "],
  [/°C\b/g, " degrees Celsius"],
  [/°F\b/g, " degrees Fahrenheit"],
  [/°/g, " degrees"],
  [/\be\.g\.(?=\s|,|$)/gi, "for example"],
  [/\bi\.e\.(?=\s|,|$)/gi, "that is"],
  [/\betc\./gi, "et cetera."],
]

/**
 * Speaks one currency amount, such as "£2.50" as "2 pounds 50" and "£0.40" as "40 pence".
 * @param symbol Currency symbol from `CURRENCIES`.
 * @param whole Whole units, possibly with thousands separators.
 * @param fraction Digits after the decimal point, if any.
 * @param scale Optional scale suffix such as "m" or "million".
 * @returns The spoken amount.
 */
function spokenAmount(
  symbol: string,
  whole: string,
  fraction: string | undefined,
  scale: string | undefined
): string {
  const [major, majorPlural, minor, minorPlural] = CURRENCIES[symbol]
  if (scale) {
    const scaleWord = SCALES[scale.toLowerCase()] ?? scale.toLowerCase()
    return `${whole}${fraction ? `.${fraction}` : ""} ${scaleWord} ${majorPlural}`
  }
  const units = whole === "1" ? major : majorPlural
  if (!fraction || /^0+$/.test(fraction)) return `${whole} ${units}`
  // Only a two digit fraction is a minor unit count; "£1.5" is one and a half pounds.
  if (fraction.length !== 2) return `${whole}.${fraction} ${majorPlural}`
  const minorCount = String(Number(fraction))
  const minorUnits = minorCount === "1" ? minor : minorPlural
  if (/^0+$/.test(whole.replace(/,/g, ""))) return `${minorCount} ${minorUnits}`
  return `${whole} ${units} ${minorCount}`
}

/**
 * Rewrites written notation in prose into words the speech model reads naturally.
 * @param text Plain prose without Markdown syntax.
 * @returns Prose with currency, powers, simple fractions, and symbols spelled out.
 */
export function spokenProse(text: string): string {
  let spoken = text
    // A dash after an amount, or an en dash between numbers, is a range: "£5 to £10", "5 to 10".
    // A plain hyphen between numbers stays, since it may be subtraction or part of a date.
    .replace(
      /([£$€¥₹]\d+(?:[.,]\d+)*(?:k|m|bn)?)\s?[-–]\s?(?=[£$€¥₹]?\d)/g,
      "$1 to "
    )
    .replace(/(\d)\s?–\s?(?=\d)/g, "$1 to ")
    // Currency symbols come before the number in writing but after it in speech.
    .replace(
      /(?<![\p{L}\p{N}])(-|−)?([£$€¥₹])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|m|bn|tn|thousand|million|billion|trillion)\b)?/giu,
      (_, negative: string | undefined, symbol, whole, fraction, scale) =>
        `${negative ? "minus " : ""}${spokenAmount(symbol, whole, fraction, scale)}`
    )
    .replace(/\b(\d+)p\b/g, (_, amount: string) =>
      amount === "1" ? "1 penny" : `${amount} pence`
    )
    .replace(
      /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻ⁿ]+/g,
      (raised) => `^{${[...raised].map((char) => SUPERSCRIPTS[char]).join("")}}`
    )
    // Powers written inline in prose, such as "x^2" or "10^{-3}".
    .replace(
      /([\p{L}\p{N})\]]+)\^(\{[^{}]*\}|-?[\p{L}\p{N}.]+)/gu,
      (match, base: string, exponent: string) => {
        // Unlike TeX, prose "x^23" means the whole number is the exponent.
        const power = spokenMath(
          `{}^${exponent.startsWith("{") ? exponent : `{${exponent}}`}`
        )
        return power ? `${base} ${power}` : match
      }
    )
    // A lone numeric fraction such as "3/4"; dates and paths contain more than one slash.
    .replace(/(?<![\d/.,])(\d+)\/(\d+)(?![\d/])/g, "$1 over $2")
  for (const [pattern, replacement] of PROSE_SYMBOLS)
    spoken = spoken.replace(pattern, replacement)
  return spoken
}

/**
 * Ends a spoken block with punctuation so the speech model pauses before the next block.
 * @param text One heading, paragraph line, list item, or table row.
 * @returns The text with terminal punctuation, or an empty string when there is nothing to say.
 */
function sentence(text: string): string {
  const trimmed = text
    .replace(/\s+/g, " ")
    // Formulas end in pauses, which must not leave stray commas before the sentence punctuation.
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,+([.;:!?])/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) return ""
  return /[.!?:;…]["'”’)]*$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Collects spoken text from inline tokens. Line breaks stay as newlines so each line becomes a sentence.
 * @param tokens Inline Marked tokens.
 * @returns Spoken text for the run.
 */
function inlineText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "math":
          return ` ${spokenMath((token as unknown as { text: string }).text)} `
        case "br":
          return "\n"
        case "codespan":
          return markdownText(token.text)
        case "image":
        case "html":
          return ""
        default:
          if ("tokens" in token && token.tokens) return inlineText(token.tokens)
          if ("text" in token && typeof token.text === "string")
            return spokenProse(markdownText(token.text))
          return ""
      }
    })
    .join("")
}

/**
 * Turns inline content into sentences, splitting at hard line breaks.
 * @param tokens Inline Marked tokens for one block.
 * @returns One sentence per non-empty line.
 */
function inlineSentences(tokens: readonly Token[]): string[] {
  return inlineText(tokens).split("\n").map(sentence).filter(Boolean)
}

/**
 * Collects spoken sentences from block tokens in reading order.
 * @param tokens Block-level Marked tokens.
 * @returns Sentences for headings, paragraphs, list items, quotes, tables, and display formulas.
 */
function blockSentences(tokens: readonly Token[]): string[] {
  return tokens.flatMap((token): string[] => {
    switch (token.type) {
      case "code":
      case "space":
      case "hr":
      case "html":
      case "image":
        return []
      case "math":
        return [
          sentence(spokenMath((token as unknown as { text: string }).text)),
        ]
      case "list":
        return (token as Tokens.List).items.flatMap((item) =>
          blockSentences(item.tokens)
        )
      case "table": {
        const table = token as Tokens.Table
        // Each row reads as one sentence with its cells separated by short pauses.
        return [table.header, ...table.rows]
          .map((row) =>
            sentence(
              row
                .map((cell) =>
                  inlineText(cell.tokens).replace(/\s+/g, " ").trim()
                )
                .filter(Boolean)
                .join(", ")
            )
          )
          .filter(Boolean)
      }
      case "blockquote":
        return blockSentences((token as Tokens.Blockquote).tokens)
      default:
        if ("tokens" in token && token.tokens) {
          // Tight list items wrap inline content in a block-level text token.
          const nested = token.tokens
          return nested.some((child) =>
            ["paragraph", "list", "code", "heading", "blockquote"].includes(
              child.type
            )
          )
            ? blockSentences(nested)
            : inlineSentences(nested)
        }
        if ("text" in token && typeof token.text === "string")
          return [sentence(spokenProse(markdownText(token.text)))].filter(
            Boolean
          )
        return []
    }
  })
}

/**
 * Converts a Markdown reply or lesson into the text read aloud.
 * @param markdown Reply or lesson Markdown, which may contain TeX formulas and fenced blocks.
 * @returns One sentence per line, each ending in punctuation; empty when nothing is speakable.
 */
export function spokenMarkdownText(markdown: string): string {
  return blockSentences(parseMarkdown(markdown, { math: true }))
    .map((line) => spokenAudioText(line))
    .filter(Boolean)
    .join("\n")
}
