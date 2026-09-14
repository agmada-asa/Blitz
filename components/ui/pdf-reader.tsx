"use client"

/**
 * Renders a bounded PDF page with navigation and highlights matching extracted citation text.
 *
 * Manages PDF.js document and worker lifecycles safely, ensuring loading task destruction
 * is properly awaited across remounts and tab switches to prevent worker race conditions.
 */
import { useEffect, useRef, useState } from "react"
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextItem,
} from "pdfjs-dist/types/src/display/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Serializes PDF document loading task destruction across instances to avoid
 * race conditions where a new PDFWorker or getDocument call begins while an existing
 * worker is in the process of tearing down.
 */
let pendingDestroy: Promise<void> = Promise.resolve()

/**
 * Enqueues a loading task's destroy call onto the global destruction queue and returns the promise.
 *
 * @param task - The active PDFDocumentLoadingTask to destroy.
 * @returns A promise that resolves when the task's destruction has completed.
 */
function queueTaskDestroy(
  task: { destroy: () => Promise<void> } | undefined
): Promise<void> {
  if (!task) return Promise.resolve()
  const next = pendingDestroy
    .catch(() => undefined)
    .then(() => task.destroy())
    .catch(() => undefined)
  pendingDestroy = next
  return next
}

/**
 * Displays original PDF pages through the existing PDF.js runtime; text remains available in the parent reader.
 *
 * Decouples document loading from page rendering so navigation and resizing do not reload the PDF.
 */
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
  const renderTaskRef = useRef<RenderTask | null>(null)

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [prevInitialPage, setPrevInitialPage] = useState(initialPage)
  const [page, setPage] = useState(initialPage)
  const [pageInput, setPageInput] = useState(String(initialPage))
  const [count, setCount] = useState<number>()
  const [status, setStatus] = useState("Loading PDF…")
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(400)

  // Synchronize internal page state when initialPage prop changes without an extra effect cycle
  if (prevInitialPage !== initialPage) {
    setPrevInitialPage(initialPage)
    setPage(initialPage)
    setPageInput(String(initialPage))
  }

  // Track container width while ignoring 0-width rects when hidden in inactive tabs
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.floor(entry.contentRect.width)
      if (nextWidth > 0) {
        setWidth(nextWidth)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Loads the PDF document asynchronously, awaiting any pending worker destruction before starting
  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | undefined

    /** Loads and initializes the PDF document for the given URL. */
    async function loadDocument() {
      setStatus("Loading PDF…")
      try {
        const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs")
        // Await any pending loading task destruction to avoid worker destruction collisions
        await pendingDestroy
        if (cancelled) return

        const task = pdfjs.getDocument({ url })
        loadingTask = task
        const document = await task.promise
        if (cancelled) {
          void queueTaskDestroy(task)
          return
        }

        setPdfDoc(document)
        setCount(document.numPages)
        setStatus("")
      } catch (error) {
        if (!cancelled) {
          setPdfDoc(null)
          setStatus(
            error instanceof Error
              ? error.message
              : "PDF could not be loaded. Read the Passage tab or try again."
          )
        }
      }
    }

    void loadDocument()

    return () => {
      cancelled = true
      if (loadingTask) {
        void queueTaskDestroy(loadingTask)
      }
    }
  }, [url, attempt])

  // Renders the selected physical page whenever the document, page, width, or highlight quote changes
  useEffect(() => {
    let cancelled = false

    /** Loads and renders the selected physical page, ignoring cancelled selections and resizes. */
    async function renderPage() {
      if (!pdfDoc) return
      const canvas = canvasRef.current
      if (!canvas || width <= 0) return

      // Cancel any previous in-flight render task on this canvas before starting a new one
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel()
        } catch {
          // Ignore cancellation errors
        }
        renderTaskRef.current = null
      }

      try {
        if (page < 1 || (pdfDoc.numPages && page > pdfDoc.numPages)) {
          throw new Error(
            `This PDF has ${pdfDoc.numPages} pages. Choose a page within that range.`
          )
        }

        const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs")
        if (cancelled) return

        const pdfPage = await pdfDoc.getPage(page)
        if (cancelled) {
          pdfPage.cleanup()
          return
        }

        const rawViewport = pdfPage.getViewport({ scale: 1 })
        const scale = width / rawViewport.width
        const viewport = pdfPage.getViewport({ scale })

        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        const context = canvas.getContext("2d")
        if (!context) {
          pdfPage.cleanup()
          throw new Error("PDF preview is unavailable.")
        }

        const renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        })
        renderTaskRef.current = renderTask

        await renderTask.promise
        renderTaskRef.current = null
        if (cancelled) {
          pdfPage.cleanup()
          return
        }

        // Highlight matching citation text if present on this page
        const content = await pdfPage.getTextContent()
        if (cancelled) {
          pdfPage.cleanup()
          return
        }

        const items = content.items.filter(
          (item): item is TextItem => "str" in item
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
        pdfPage.cleanup()
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          (error as { name: string }).name === "RenderingCancelledException"
        ) {
          return
        }
        if (!cancelled) {
          setStatus(
            error instanceof Error
              ? error.message
              : "PDF page could not be rendered."
          )
        }
      }
    }

    void renderPage()

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel()
        } catch {
          // Ignore cancellation errors
        }
        renderTaskRef.current = null
      }
    }
  }, [pdfDoc, page, width, quote, initialPage])

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
          {status !== "Loading PDF…" && !pdfDoc ? (
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
