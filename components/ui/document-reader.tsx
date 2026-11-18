"use client"

/**
 * Shows a Word original (`.docx`) in the source reader with its own
 * formatting, scrolled to the cited passage with it highlighted.
 *
 * Rendering is done in the browser by `docx-preview`, loaded only when a Word
 * source is opened. Pages keep the document's look but reflow to the
 * reader's width, so the pane works beside a chat and on a phone.
 *
 * The document is drawn inside a shadow root. `docx-preview` writes the
 * document's styles into a `<style>` element without escaping values taken
 * from the file (list numbering text, style names), so a crafted `.docx`
 * could otherwise restyle the whole app. In the shadow root those rules only
 * reach the document and, through `:host`, the element holding it. A `:host`
 * rule could still make that element `position: fixed` over the whole app,
 * so the scroll area around it uses paint containment: fixed positioning is
 * then relative to the reader, and anything drawn outside it is clipped.
 */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  clearQuoteHighlight,
  highlightQuote,
  scrollRangeIntoView,
} from "@/lib/client/source-highlight"
import { markdownHref } from "@/lib/markdown"

/** Largest Word file rendered in the browser. Matches the import limit for Word documents. */
const MAX_DOCX_BYTES = 20_000_000

/**
 * Reader styles inside the document's shadow root, where the app's stylesheet
 * does not reach. Pages stay paper-white in dark mode because the document
 * sets its own colours; `--border`, `--radius` and `--brand` inherit from
 * the app. The passage highlight must be declared here too.
 */
const DOCUMENT_STYLES = `
section.docx {
  min-height: 0 !important;
  border: 1px solid var(--border) !important;
  border-radius: calc(var(--radius) * 0.6) !important;
  background: white !important;
  color: black !important;
  padding: 1.5rem !important;
}
section.docx + section.docx { margin-top: 1rem; }
img { max-width: 100%; }
::highlight(source-quote) {
  background-color: color-mix(in oklab, var(--brand) 30%, transparent);
}
`

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

/**
 * Makes the document's links safe to click inside the app.
 *
 * `docx-preview` copies a hyperlink's target into `href` unchanged, so a
 * document could carry a `javascript:` link that would run in Blitz when
 * clicked. Links inside the document (`#bookmark`) are kept; web and mail
 * links are kept only when `markdownHref` accepts them and open in a new tab;
 * anything else loses its `href` and stays as plain text.
 *
 * @param body The container `docx-preview` rendered into.
 */
function secureLinks(body: HTMLElement): void {
  for (const link of Array.from(body.querySelectorAll("a[href]"))) {
    const value = link.getAttribute("href") ?? ""
    if (/^#[^\s]*$/.test(value)) continue
    const href = markdownHref(value)
    if (!href) {
      link.removeAttribute("href")
      continue
    }
    link.setAttribute("href", href)
    link.setAttribute("target", "_blank")
    link.setAttribute("rel", "noopener noreferrer")
  }
}

/**
 * Follows a click on a link to a bookmark inside the document.
 *
 * Bookmarks live in the shadow root, where the browser's own `#id`
 * navigation cannot find them, so the click scrolls to the bookmark instead
 * of changing the app's URL. Other clicks are left alone.
 *
 * @param shadow The shadow root holding the drawn document.
 * @param event The click inside the document.
 */
function followBookmark(shadow: ShadowRoot, event: MouseEvent): void {
  const link =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[href^="#"]')
      : null
  if (!link) return
  event.preventDefault()
  // `docx-preview` writes the bookmark name unencoded into both `href` and `id`.
  const id = link.getAttribute("href")?.slice(1)
  if (id) shadow.getElementById(id)?.scrollIntoView({ block: "start" })
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
  // Holds the shadow root; the document's own containers are created inside it.
  const hostRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Results are keyed by file and attempt, so a new file or a retry shows loading.
  const key = `${attempt}:${url}`
  const [done, setDone] = useState<{ key: string; ok: boolean }>()
  const state = done?.key !== key ? "loading" : done.ok ? "ready" : "failed"

  // Render the document into fresh containers inside the shadow root.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" })
    const sheet = document.createElement("style")
    sheet.textContent = DOCUMENT_STYLES
    const styles = document.createElement("div")
    const body = document.createElement("div")
    shadow.replaceChildren(sheet, styles, body)
    bodyRef.current = body
    const onClick = (event: MouseEvent) => followBookmark(shadow, event)
    body.addEventListener("click", onClick)
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
          // Embedded HTML chunks are drawn in an unsandboxed same-origin
          // iframe, where their scripts would run in the app. Leave them out.
          renderAltChunks: false,
          useBase64URL: true,
        })
      })
      .then(() => {
        if (cancelled) return
        secureLinks(body)
        fixSymbolBullets(styles)
        setDone({ key, ok: true })
      })
      .catch(() => {
        if (!cancelled) setDone({ key, ok: false })
      })
    return () => {
      cancelled = true
      body.removeEventListener("click", onClick)
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
    // Paint containment keeps the document's `:host` styles inside the reader.
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [contain:paint]"
    >
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
      <div ref={hostRef} hidden={state !== "ready"} />
    </div>
  )
}
