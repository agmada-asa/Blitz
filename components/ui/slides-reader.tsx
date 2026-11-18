"use client"

/**
 * Shows a PowerPoint original as slides in the source reader, scrolled to the
 * cited slide with the cited text highlighted.
 *
 * The file is read in the browser by `lib/client/pptx-slides.ts`; this
 * component only draws the slide model. Font sizes and insets use container
 * query units, so each slide scales with the reader's width like a picture.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Button } from "@/components/ui/button"
import {
  clearQuoteHighlight,
  highlightQuote,
  scrollRangeIntoView,
} from "@/lib/client/source-highlight"
import {
  parsePptx,
  type SlideDeck,
  type SlideParagraph,
  type SlideShape,
} from "@/lib/client/pptx-slides"
import { cn } from "@/lib/utils"

/** Converts points to a share of the slide width in container query units. */
function slideUnits(points: number, deck: SlideDeck): string {
  return `${((points / deck.widthPoints) * 100).toFixed(3)}cqw`
}

/** Positions an element over its box on the slide. */
function boxStyle(box: SlideShape["box"]): CSSProperties {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  }
}

/** Draws the paragraphs of a text box or table cell. */
function Paragraphs({
  paragraphs,
  deck,
}: {
  paragraphs: SlideParagraph[]
  deck: SlideDeck
}) {
  return paragraphs.map((paragraph, index) => (
    <p
      key={index}
      className="relative leading-[1.15] break-words whitespace-pre-wrap"
      style={{
        textAlign: paragraph.align,
        paddingLeft: slideUnits(paragraph.indent, deck),
        marginTop: index ? slideUnits(paragraph.spaceBefore, deck) : 0,
        // An empty paragraph keeps the height of its line.
        fontSize: slideUnits(paragraph.runs[0]?.size ?? 18, deck),
        minHeight: "1.15em",
      }}
    >
      {paragraph.bullet ? (
        <span
          aria-hidden
          data-quote-ignore
          className="absolute"
          style={{
            left: slideUnits(Math.max(0, paragraph.indent - 18), deck),
            color: paragraph.runs[0]?.color,
          }}
        >
          {paragraph.bullet}
        </span>
      ) : null}
      {paragraph.runs.map((run, runIndex) => (
        <span
          key={runIndex}
          style={{
            fontSize: slideUnits(run.size, deck),
            fontWeight: run.bold ? 700 : undefined,
            fontStyle: run.italic ? "italic" : undefined,
            textDecoration: run.underline ? "underline" : undefined,
            color: run.color,
          }}
        >
          {run.text}
        </span>
      ))}
    </p>
  ))
}

/** Draws one element of a slide. */
function Shape({ shape, deck }: { shape: SlideShape; deck: SlideDeck }) {
  if (shape.kind === "image")
    return (
      // eslint-disable-next-line @next/next/no-img-element -- object URLs from the file itself; next/image cannot optimise them.
      <img
        src={shape.src}
        alt={shape.alt}
        loading="lazy"
        className="absolute object-fill"
        style={boxStyle(shape.box)}
      />
    )
  if (shape.kind === "table")
    return (
      <table
        className="absolute table-fixed border-collapse"
        style={boxStyle(shape.box)}
      >
        <tbody>
          {shape.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border border-black/20 align-top"
                  style={{
                    background: cell.fill,
                    padding: slideUnits(4, deck),
                  }}
                >
                  <Paragraphs paragraphs={cell.paragraphs} deck={deck} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  return (
    <div
      className={cn(
        "absolute flex flex-col",
        shape.anchor === "middle" && "justify-center",
        shape.anchor === "bottom" && "justify-end"
      )}
      style={{
        ...boxStyle(shape.box),
        background: shape.fill,
        paddingTop: slideUnits(shape.insets.top, deck),
        paddingRight: slideUnits(shape.insets.right, deck),
        paddingBottom: slideUnits(shape.insets.bottom, deck),
        paddingLeft: slideUnits(shape.insets.left, deck),
      }}
    >
      <Paragraphs paragraphs={shape.paragraphs} deck={deck} />
    </div>
  )
}

/**
 * Loads a presentation and shows every slide, starting at the cited one.
 *
 * @param url Route serving the saved `.pptx` original.
 * @param slide Cited slide number, when the citation has one.
 * @param quote Cited passage, highlighted on the cited slide (or anywhere
 *   when no slide is known).
 */
export function SlidesReader({
  url,
  slide,
  quote,
}: {
  url: string
  slide?: number
  quote: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  // Results are keyed by file and attempt, so a new file or a retry shows loading.
  const key = `${attempt}:${url}`
  const [loaded, setLoaded] = useState<{
    key: string
    deck?: SlideDeck
    error?: string
  }>()
  const deck = loaded?.key === key ? loaded.deck : undefined
  const error = loaded?.key === key ? loaded.error : undefined

  // Fetch and read the file; release the pictures when the reader closes.
  useEffect(() => {
    let current: SlideDeck | undefined
    let cancelled = false
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error("The presentation is not available.")
        return new Uint8Array(await response.arrayBuffer())
      })
      .then((bytes) => {
        if (cancelled) return
        current = parsePptx(bytes)
        setLoaded({ key, deck: current })
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setLoaded({
            key,
            error:
              reason instanceof Error
                ? reason.message
                : "The presentation could not be shown.",
          })
      })
    return () => {
      cancelled = true
      current?.dispose()
    }
  }, [url, key])

  // Once drawn, highlight the passage and bring the cited slide into view.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!deck || !scroller) return
    const target = slide
      ? scroller.querySelector<HTMLElement>(`[data-slide="${slide}"]`)
      : null
    const range = highlightQuote(target ?? scroller, quote)
    if (range) scrollRangeIntoView(range, scroller)
    else if (target) scroller.scrollTop = target.offsetTop - scroller.offsetTop
    return clearQuoteHighlight
  }, [deck, slide, quote])

  if (error)
    return (
      <div role="alert" className="space-y-3 p-5 text-sm">
        <p>{error} The Passage tab still shows the cited text.</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    )
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {!deck ? (
        <p role="status" className="p-1 text-sm text-muted-foreground">
          Loading slides…
        </p>
      ) : (
        <ol className="space-y-5" aria-label="Slides">
          {deck.slides.map((item) => (
            <li key={item.number} data-slide={item.number} className="space-y-1.5">
              <p
                data-quote-ignore
                className={cn(
                  "text-xs text-muted-foreground",
                  item.number === slide && "font-medium text-foreground"
                )}
              >
                Slide {item.number}
                {item.number === slide ? " · cited" : ""}
              </p>
              <div
                className={cn(
                  "relative w-full overflow-hidden rounded-sm border bg-white bg-cover bg-center text-black [container-type:inline-size]",
                  item.number === slide && "ring-2 ring-brand/50"
                )}
                style={{
                  aspectRatio: deck.aspectRatio,
                  backgroundColor: item.background,
                  backgroundImage: item.backgroundImage
                    ? `url("${item.backgroundImage}")`
                    : undefined,
                }}
              >
                {item.shapes.map((shape, index) => (
                  <Shape key={index} shape={shape} deck={deck} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
