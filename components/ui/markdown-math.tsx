"use client"

/** Displays generated formulas with local KaTeX, retaining readable source when syntax is invalid. */
import { useMemo } from "react"
import katex from "katex"

/** Renders accessible math without trusted HTML commands or shared mutable macro definitions. */
export function MarkdownMath({
  text,
  display = false,
  inline = false,
}: {
  text: string
  display?: boolean
  inline?: boolean
}) {
  const markup = useMemo(() => {
    try {
      return katex.renderToString(text, {
        displayMode: display,
        output: "htmlAndMathml",
        throwOnError: true,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 1000,
      })
    } catch {
      return undefined
    }
  }, [text, display])

  const Element = display && !inline ? "div" : "span"
  return markup ? (
    <Element
      className={
        display ? "markdown-math markdown-math-display" : "markdown-math"
      }
      // KaTeX escapes formula input and blocks HTML/URL commands with trust: false.
      dangerouslySetInnerHTML={{ __html: markup }}
      tabIndex={display ? 0 : undefined}
    />
  ) : (
    <Element
      className="markdown-math-fallback"
      title="This formula could not be rendered"
    >
      <code>{text}</code>
    </Element>
  )
}
