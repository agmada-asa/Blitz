"use client"

/** Renders a bounded PDF page with navigation and highlights matching extracted citation text. */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Displays original PDF pages through the existing PDF.js runtime; text remains available in the parent reader. */
export function PdfReader({
  url,
  initialPage,
  quote,
}: {
  url: string
  initialPage: number
  quote: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(initialPage)
  const [pageInput, setPageInput] = useState(String(initialPage))
  const [count, setCount] = useState<number>()
  const [status, setStatus] = useState("Loading PDF…")
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(400)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, Math.floor(entry.contentRect.width)))
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    let destroy: (() => Promise<void>) | undefined
    /** Loads and renders the selected physical page, ignoring cancelled selections and resizes. */
    async function render() {
      setStatus("Loading PDF…")
      try {
        const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs")
        if (cancelled) return
        const task = pdfjs.getDocument({ url })
        destroy = () => task.destroy()
        const document = await task.promise
        if (cancelled) return
        setCount(document.numPages)
        if (page < 1 || page > document.numPages)
          throw new Error(
            `This PDF has ${document.numPages} pages. Choose a page within that range.`
          )
        const pdfPage = await document.getPage(page)
        const viewport = pdfPage.getViewport({
          scale: width / pdfPage.getViewport({ scale: 1 }).width,
        })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext("2d")
        if (!context) throw new Error("PDF preview is unavailable.")
        await pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        }).promise
        if (cancelled) return
        const content = await pdfPage.getTextContent()
        const items = content.items.filter(
          (item): item is import("pdfjs-dist/types/src/display/api").TextItem =>
            "str" in item
        )
        const joined = items
          .map((item) => item.str.replace(/\s+/g, " "))
          .join(" ")
        const needle = quote
          .replace(/^\s*\[Page[^\]]+\]\s*/i, "")
          .replace(/\s+/g, " ")
          .trim()
        const match = needle ? joined.indexOf(needle) : -1
        if (match >= 0) {
          let offset = 0
          context.save()
          context.scale(ratio, ratio)
          context.fillStyle = "rgba(255, 210, 60, 0.30)"
          for (const item of items) {
            const length = item.str.replace(/\s+/g, " ").length
            if (offset < match + needle.length && offset + length > match) {
              const transform = pdfjs.Util.transform(
                viewport.transform,
                item.transform
              )
              const height = Math.hypot(transform[2], transform[3])
              context.fillRect(
                transform[4],
                transform[5] - height,
                item.width * viewport.scale,
                height * 1.2
              )
            }
            offset += length + 1
          }
          context.restore()
        }
        setStatus(
          match < 0 && page === initialPage
            ? "Read the Passage tab for the exact cited text."
            : ""
        )
      } catch (error) {
        if (!cancelled)
          setStatus(
            error instanceof Error
              ? error.message
              : "PDF could not be loaded. Read the Passage tab or try again."
          )
      }
    }
    void render()
    return () => {
      cancelled = true
      void destroy?.().catch(() => undefined)
    }
  }, [url, page, width, quote, initialPage, attempt])

  /** Navigates to a known page and keeps the editable page control synchronized. */
  function navigate(value: number) {
    setPage(value)
    setPageInput(String(value))
  }

  return (
    <div ref={containerRef} className="min-w-0 space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const value = Number(pageInput)
          if (
            Number.isInteger(value) &&
            value >= 1 &&
            (!count || value <= count)
          )
            navigate(value)
        }}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => navigate(page - 1)}
          aria-label="Previous PDF page"
        >
          Previous
        </Button>
        <label className="flex items-center gap-2 text-xs">
          Page{" "}
          <Input
            className="h-9 w-16"
            type="number"
            min={1}
            max={count}
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
          />
        </label>
        <span className="text-xs text-muted-foreground">
          {count ? `of ${count}` : ""}
        </span>
        <Button type="submit" variant="ghost" size="sm">
          Go
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!count || page >= count}
          onClick={() => navigate(page + 1)}
          aria-label="Next PDF page"
        >
          Next
        </Button>
      </form>
      {status ? (
        <div className="text-xs text-muted-foreground">
          <p role="status">{status}</p>
          {status !== "Loading PDF…" ? (
            <Button
              variant="link"
              className="px-0"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Reload PDF
            </Button>
          ) : null}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="max-w-full bg-white"
        aria-label={`Original PDF page ${page}. The Passage tab contains accessible source text.`}
        role="img"
      />
    </div>
  )
}
