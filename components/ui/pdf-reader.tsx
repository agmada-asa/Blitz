"use client"

/**
 * Renders a continuous, lazy-loaded PDF with navigation and citation highlights.
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
import { pdfHighlightItems } from "@/lib/citations"

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
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>())
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const renderTasksRef = useRef(new Map<number, RenderTask>())
  const renderSettingsRef = useRef("")

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [prevInitialPage, setPrevInitialPage] = useState(initialPage)
  const [pageInput, setPageInput] = useState(String(initialPage))
  const [count, setCount] = useState<number>()
  const [pageSizes, setPageSizes] = useState<Record<number, number>>({})
  const [visiblePages, setVisiblePages] = useState<number[]>([])
  const [activePage, setActivePage] = useState(initialPage)
  const [status, setStatus] = useState("Loading PDF…")
  const [attempt, setAttempt] = useState(0)
  const [width, setWidth] = useState(400)
  const [zoom, setZoom] = useState(1)

  // Synchronize internal page state when initialPage prop changes without an extra effect cycle
  if (prevInitialPage !== initialPage) {
    setPrevInitialPage(initialPage)
    setPageInput(String(initialPage))
    setActivePage(initialPage)
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
      setPageSizes({})
      setVisiblePages([])
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

  // Loads page aspect ratios to reserve continuous-scroll space before visible pages render.
  useEffect(() => {
    let cancelled = false
    /** Measures every page so scrolling remains stable as canvases render lazily. */
    async function measurePages() {
      if (!pdfDoc) return
      const sizes: Record<number, number> = {}
      for (let number = 1; number <= pdfDoc.numPages; number += 1) {
        const pdfPage = await pdfDoc.getPage(number)
        const viewport = pdfPage.getViewport({ scale: 1 })
        sizes[number] = viewport.height / viewport.width
        pdfPage.cleanup()
        if (cancelled) return
      }
      setPageSizes(sizes)
    }
    void measurePages()
    return () => {
      cancelled = true
    }
  }, [pdfDoc])

  // Starts cited source views at the referenced page after all page placeholders exist.
  useEffect(() => {
    const target = pageRefs.current.get(initialPage)
    const scroller = scrollRef.current
    if (!target || !scroller || !pageSizes[initialPage]) return
    scroller.scrollTop +=
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, [initialPage, pageSizes])

  // Tracks pages near the scroll viewport so only nearby canvases need rendering.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !count || Object.keys(pageSizes).length !== count) return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((current) => {
          const next = new Set(current)
          for (const entry of entries) {
            const number = Number((entry.target as HTMLElement).dataset.page)
            if (entry.isIntersecting) next.add(number)
            else next.delete(number)
          }
          const updated = [...next].sort((a, b) => a - b)
          return updated.length === current.length &&
            updated.every((number, index) => number === current[index])
            ? current
            : updated
        })
      },
      { root, rootMargin: "300px 0px", threshold: [0, 0.25, 0.5, 0.75] }
    )
    for (const node of pageRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [count, pageSizes])

  // Renders only pages near the viewport, keeping long PDFs from allocating every canvas at once.
  useEffect(() => {
    let cancelled = false
    const renderSettings = `${width}:${zoom}:${window.devicePixelRatio || 1}:${quote}`
    if (renderSettingsRef.current !== renderSettings) {
      for (const canvas of canvasRefs.current.values()) {
        delete canvas.dataset.renderSettings
      }
      renderSettingsRef.current = renderSettings
    }

    /** Renders a visible page and overlays matching citation text when present. */
    async function renderPage(number: number) {
      const canvas = canvasRefs.current.get(number)
      if (!pdfDoc || !canvas || width <= 0) return
      try {
        const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs")
        if (cancelled) return
        const pdfPage = await pdfDoc.getPage(number)
        if (cancelled) {
          pdfPage.cleanup()
          return
        }

        const rawViewport = pdfPage.getViewport({ scale: 1 })
        const scale = (width / rawViewport.width) * zoom
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
        renderTasksRef.current.set(number, renderTask)

        await renderTask.promise
        renderTasksRef.current.delete(number)
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
        // Sentence-level matching runs only on the cited page, where a
        // running header repeated on every page cannot cause a false match.
        const highlighted = quote.trim()
          ? pdfHighlightItems(
              items.map((item) => item.str),
              quote,
              { fragments: number === initialPage }
            )
          : new Set<number>()

        if (highlighted.size) {
          context.save()
          context.scale(ratio, ratio)
          context.fillStyle = "rgba(255, 210, 60, 0.30)"
          items.forEach((item, index) => {
            if (!highlighted.has(index)) return
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
          })
          context.restore()
        }

        if (number === initialPage) {
          setStatus(
            quote.trim() && !highlighted.size
              ? "Read the Passage tab for the exact cited text."
              : ""
          )
        }
        canvas.dataset.renderSettings = renderSettings
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

    const renderTasks = renderTasksRef.current
    for (const task of renderTasks.values()) {
      try {
        task.cancel()
      } catch {
        /* Ignore cancellation errors. */
      }
    }
    renderTasks.clear()
    const keepFrom = visiblePages.length ? Math.max(1, visiblePages[0] - 2) : 1
    const keepThrough = visiblePages.length
      ? visiblePages[visiblePages.length - 1] + 2
      : 0
    for (const [number, canvas] of canvasRefs.current) {
      if (number < keepFrom || number > keepThrough) {
        canvas.width = 0
        canvas.height = 0
        delete canvas.dataset.renderSettings
      }
    }
    const pagesToRender = [...visiblePages]
    for (const pageNumber of pagesToRender) {
      const canvas = canvasRefs.current.get(pageNumber)
      if (canvas?.dataset.renderSettings !== renderSettings) {
        void renderPage(pageNumber)
      }
    }

    return () => {
      cancelled = true
      for (const task of renderTasks.values()) {
        try {
          task.cancel()
        } catch {
          /* Ignore cancellation errors. */
        }
      }
      renderTasks.clear()
    }
  }, [pdfDoc, visiblePages, width, zoom, quote, initialPage])

  /** Navigates to a known page and keeps the editable page control synchronized. */
  function navigate(value: number) {
    setActivePage(value)
    setPageInput(String(value))
    pageRefs.current
      .get(value)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  /** Keeps page navigation synchronized with the page at the viewer's vertical midpoint. */
  function updateActivePage() {
    const scroller = scrollRef.current
    if (!scroller) return
    const midpoint =
      scroller.getBoundingClientRect().top + scroller.clientHeight / 2
    let closestPage = activePage
    let closestDistance = Number.POSITIVE_INFINITY
    for (const [number, node] of pageRefs.current) {
      const bounds = node.getBoundingClientRect()
      if (bounds.top <= midpoint && bounds.bottom >= midpoint) {
        closestPage = number
        break
      }
      const distance = Math.min(
        Math.abs(bounds.top - midpoint),
        Math.abs(bounds.bottom - midpoint)
      )
      if (distance < closestDistance) {
        closestDistance = distance
        closestPage = number
      }
    }
    if (closestPage !== activePage) {
      setActivePage(closestPage)
      setPageInput(String(closestPage))
    }
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
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-10 text-2xl"
            disabled={activePage <= 1}
            onClick={() => navigate(activePage - 1)}
            aria-label="Previous PDF page"
          >
            ‹
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-10 text-2xl"
            disabled={!count || activePage >= count}
            onClick={() => navigate(activePage + 1)}
            aria-label="Next PDF page"
          >
            ›
          </Button>
        </div>
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
        <span className="mx-1 h-5 border-l border-border" aria-hidden="true" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={zoom <= 0.5}
          onClick={() =>
            setZoom((value) =>
              Math.max(0.5, Math.round((value - 0.1) * 10) / 10)
            )
          }
          aria-label="Zoom out"
        >
          −
        </Button>
        <span
          className="min-w-12 text-center text-xs tabular-nums"
          aria-live="polite"
        >
          {Math.round(zoom * 100)}%
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={zoom >= 2}
          onClick={() =>
            setZoom((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10))
          }
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={zoom === 1}
          onClick={() => setZoom(1)}
          aria-label="Reset zoom to fit width"
        >
          Fit
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
      <div
        ref={scrollRef}
        onScroll={updateActivePage}
        className="max-h-[80svh] min-h-[50svh] space-y-3 overflow-auto rounded-lg border border-border bg-muted/30 p-2"
      >
        {count
          ? Array.from({ length: count }, (_, index) => {
              const number = index + 1
              const aspect = pageSizes[number] ?? 1.3
              return (
                <div
                  key={number}
                  ref={(node) => {
                    if (node) pageRefs.current.set(number, node)
                    else pageRefs.current.delete(number)
                  }}
                  data-page={number}
                  className="mx-auto overflow-hidden bg-white shadow-sm"
                  style={{
                    width: `${width * zoom}px`,
                    aspectRatio: `1 / ${aspect}`,
                  }}
                  aria-label={`PDF page ${number}`}
                >
                  <canvas
                    ref={(node) => {
                      if (node) canvasRefs.current.set(number, node)
                      else canvasRefs.current.delete(number)
                    }}
                    className="mx-auto block bg-white"
                    aria-label={
                      quote.trim()
                        ? `Original PDF page ${number}. The Passage tab contains accessible source text.`
                        : `Original PDF page ${number}. Extracted text is available in the adjacent tab.`
                    }
                    role="img"
                  />
                </div>
              )
            })
          : null}
      </div>
    </div>
  )
}
