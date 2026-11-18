"use client"

/**
 * Shows a Word original (`.docx`) in the source reader with its own
 * formatting, scrolled to the cited passage with it highlighted.
 *
 * Rendering is done in the browser by `docx-preview`, loaded only when a Word
 * source is opened. Pages keep the document's look but reflow to the
 * reader's width, so the pane works beside a chat and on a phone.
 */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  clearQuoteHighlight,
  highlightQuote,
  scrollRangeIntoView,
} from "@/lib/client/source-highlight"

/** Largest Word file rendered in the browser. Matches the import limit for Word documents. */
const MAX_DOCX_BYTES = 20_000_000

/**
 * Word draws most bullets with private-use characters of the Symbol and
 * Wingdings fonts, which browsers show as empty boxes. These are the common
 * ones, mapped to the Unicode characters they look like.
 */
const SYMBOL_BULLETS: Record<string, string> = {
  "": "•",
  "": "▪",
  "": "➢",
  "": "❖",
  "": "✓",
  "": "□",
  "": "■",
}

/** Replaces Symbol and Wingdings bullets in the rendered list styles. */
function fixSymbolBullets(styles: HTMLElement): void {
  for (const style of Array.from(styles.querySelectorAll("style"))) {
    const text = style.textContent ?? ""
    const fixed = text.replace(
      /[]/g,
      (character) => SYMBOL_BULLETS[character]
    )
    if (fixed !== text) style.textContent = fixed
  }
}

/**
 * Loads a Word document and highlights the cited passage.
 *
 * @param url Route serving the saved `.docx` original.
 * @param quote Cited passage, as extracted (Markdown headings and lists).
 */
export function DocumentReader({ url, quote }: { url: string; quote: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  // Results are keyed by file and attempt, so a new file or a retry shows loading.
  const key = `${attempt}:${url}`
  const [done, setDone] = useState<{ key: string; ok: boolean }>()
  const state = done?.key !== key ? "loading" : done.ok ? "ready" : "failed"

  // Render the document into this component's own containers.
  useEffect(() => {
    const body = bodyRef.current
    const styles = styleRef.current
    if (!body || !styles) return
    let cancelled = false
    body.replaceChildren()
    styles.replaceChildren()
    Promise.all([
      fetch(url).then(async (response) => {
        if (!response.ok) throw new Error("unavailable")
        const blob = await response.blob()
        if (blob.size > MAX_DOCX_BYTES) throw new Error("too large")
        return blob
      }),
      import("docx-preview"),
    ])
      .then(([blob, docx]) => {
        if (cancelled) return
        return docx.renderAsync(blob, body, styles, {
          className: "docx",
          inWrapper: false,
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: true,
          renderHeaders: false,
          renderFooters: false,
          renderComments: false,
          renderChanges: false,
          useBase64URL: true,
        })
      })
      .then(() => {
        if (cancelled) return
        fixSymbolBullets(styles)
        setDone({ key, ok: true })
      })
      .catch(() => {
        if (!cancelled) setDone({ key, ok: false })
      })
    return () => {
      cancelled = true
    }
  }, [url, key])

  // Once rendered, highlight the passage and scroll to it.
  useEffect(() => {
    const scroller = scrollRef.current
    const body = bodyRef.current
    if (state !== "ready" || !scroller || !body) return
    const range = highlightQuote(body, quote)
    if (range) scrollRangeIntoView(range, scroller)
    return clearQuoteHighlight
  }, [state, quote])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {state === "loading" ? (
        <p role="status" className="p-1 text-sm text-muted-foreground">
          Loading document…
        </p>
      ) : null}
      {state === "failed" ? (
        <div role="alert" className="space-y-3 p-1 text-sm">
          <p>
            This document could not be shown. The Passage tab still shows the
            cited text.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <div ref={styleRef} hidden />
      {/* Word pages stay paper-white in dark mode; the document sets its own colours. */}
      <div
        ref={bodyRef}
        className={
          state === "ready"
            ? "space-y-4 [&_section.docx]:!min-h-0 [&_section.docx]:!rounded-sm [&_section.docx]:!border [&_section.docx]:!bg-white [&_section.docx]:!p-6 [&_section.docx]:!text-black [&_img]:max-w-full"
            : "hidden"
        }
      />
    </div>
  )
}
