/**
 * Splits a Teach reply into the parts the native lesson draws: Markdown text,
 * validated interactive blocks (quiz, steps, viz, follow-ups), and
 * placeholders for blocks still being written. Outline and section fences
 * are removed first, because the Teach screen shows them as its own
 * navigation, exactly as on desktop.
 *
 * Pure, so it can be tested without React Native.
 */

import { lexer, type Token } from "marked"

import {
  isClosedCodeFence,
  isInteractiveBlockLanguage,
  parseInteractiveBlock,
  splitFenceInfo,
  type InteractiveBlock,
} from "../../lib/interactive-blocks.ts"
import { stripTeachMarkers } from "../../lib/teach.ts"

/** One part of a lesson reply, in reading order. */
export type TeachPart =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "block"; readonly block: InteractiveBlock }
  /** An interactive block whose closing fence has not streamed in yet. */
  | { readonly kind: "pending"; readonly language: string }

/**
 * Splits a reply into Markdown and interactive blocks. A block that fails
 * validation stays in the Markdown as a visible code block, so nothing the
 * tutor wrote is lost.
 * @param content The assistant message's Markdown.
 * @param streaming True while the reply is still being written; an unclosed
 * interactive fence then becomes a placeholder instead of raw JSON.
 */
export function teachParts(content: string, streaming: boolean): TeachPart[] {
  const parts: TeachPart[] = []
  let markdown = ""

  /** Moves collected Markdown into the parts list. */
  const flush = () => {
    if (markdown.trim()) parts.push({ kind: "markdown", text: markdown.trim() })
    markdown = ""
  }

  for (const token of lexer(stripTeachMarkers(content), { gfm: true }) as Token[]) {
    if (token.type === "code" && "lang" in token) {
      const info = typeof token.lang === "string" ? token.lang : ""
      const { language } = splitFenceInfo(info)
      if (isInteractiveBlockLanguage(language)) {
        if (!isClosedCodeFence(token.raw)) {
          if (streaming) {
            flush()
            parts.push({ kind: "pending", language })
            continue
          }
        } else {
          const parsed = parseInteractiveBlock(info, token.text)
          if (parsed.ok) {
            flush()
            parts.push({ kind: "block", block: parsed.block })
            continue
          }
        }
      }
    }
    markdown += token.raw
  }
  flush()
  return parts
}
