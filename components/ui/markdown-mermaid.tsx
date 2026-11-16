"use client"

/**
 * Lazily renders Mermaid diagrams locally, with sanitized SVG, an "Open larger" view, and an always
 * available source view. Diagrams are drawn in the app's own palette, font and shapes rather than one of
 * Mermaid's stock themes, and redraw when the light or dark mode or the accent changes.
 */
import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import DOMPurify from "dompurify"
import { ExpandFigureButton } from "@/components/ui/interactive-blocks/expand-figure"
import { subscribeToThemeAttributes } from "@/lib/client/theme-attributes"

/** Serializes theme initialization and drawing because Mermaid has global configuration. */
let renderQueue: Promise<unknown> = Promise.resolve()

/** Semantic colour tokens from `app/globals.css` that diagrams are drawn with, keyed by palette field. */
const PALETTE_TOKENS = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  border: "--border",
  input: "--input",
  brand: "--brand",
  brandForeground: "--brand-foreground",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  chart6: "--chart-6",
} as const

/**
 * The resolved app colours and font a diagram is drawn with. Colours are the literal token values
 * (hex in `app/globals.css`), which Mermaid needs because it derives shades from them.
 */
type DiagramPalette = Record<keyof typeof PALETTE_TOKENS, string> & {
  dark: boolean
  fontFamily: string
}

/**
 * Reads the current palette as a string so `useSyncExternalStore` can compare snapshots cheaply.
 * @returns JSON of a `DiagramPalette`.
 */
function readPaletteSnapshot(): string {
  const root = getComputedStyle(document.documentElement)
  const palette: Record<string, string | boolean> = {
    dark: document.documentElement.classList.contains("dark"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  }
  for (const [field, token] of Object.entries(PALETTE_TOKENS))
    palette[field] = root.getPropertyValue(token).trim()
  return JSON.stringify(palette)
}

/**
 * Returns an empty snapshot on the server and during hydration, so drawing starts only on the client.
 * @returns An empty string.
 */
function readServerPaletteSnapshot(): string {
  return ""
}

/**
 * Maps the app palette onto Mermaid's base theme: cards on the page background, quiet borders and
 * connectors, the accent colour for note and activation borders, and the chart colours for pie slices.
 * @param palette Resolved app colours and font.
 * @returns Mermaid `themeVariables`.
 */
function diagramThemeVariables(palette: DiagramPalette) {
  const p = palette
  return {
    darkMode: p.dark,
    background: p.background,
    fontFamily: p.fontFamily,
    fontSize: "14px",
    // Shapes (flowchart, class, state, ER) and their text.
    primaryColor: p.card,
    primaryTextColor: p.foreground,
    primaryBorderColor: p.input,
    secondaryColor: p.muted,
    secondaryTextColor: p.foreground,
    secondaryBorderColor: p.input,
    tertiaryColor: p.muted,
    tertiaryTextColor: p.foreground,
    tertiaryBorderColor: p.border,
    mainBkg: p.card,
    nodeBorder: p.input,
    nodeTextColor: p.foreground,
    textColor: p.foreground,
    titleColor: p.foreground,
    // Connectors and their labels.
    lineColor: p.mutedForeground,
    edgeLabelBackground: p.background,
    // Groups.
    clusterBkg: p.background,
    clusterBorder: p.border,
    // Notes and highlights take the accent as their border. The `--accent` tint stays blue under every
    // accent setting, so their fill is neutral.
    noteBkgColor: p.muted,
    noteTextColor: p.foreground,
    noteBorderColor: p.brand,
    // Sequence diagrams.
    actorBkg: p.card,
    actorBorder: p.input,
    actorTextColor: p.foreground,
    actorLineColor: p.border,
    signalColor: p.mutedForeground,
    signalTextColor: p.foreground,
    labelBoxBkgColor: p.muted,
    labelBoxBorderColor: p.input,
    labelTextColor: p.foreground,
    loopTextColor: p.mutedForeground,
    activationBkgColor: p.muted,
    activationBorderColor: p.brand,
    sequenceNumberColor: p.brandForeground,
    // Pie charts use the same series colours as the app's charts.
    pie1: p.chart1,
    pie2: p.chart2,
    pie3: p.chart3,
    pie4: p.chart4,
    pie5: p.chart5,
    pie6: p.chart6,
    pieStrokeColor: p.background,
    pieOuterStrokeColor: p.border,
    pieOpacity: "1",
    pieSectionTextColor: "#ffffff",
    pieTitleTextSize: "16px",
    pieTitleTextColor: p.foreground,
    pieLegendTextSize: "14px",
    pieLegendTextColor: p.foreground,
    // Flat surfaces, as elsewhere in the app.
    dropShadow: "none",
    useGradient: false,
  }
}

/**
 * Shape details Mermaid's theme variables cannot express: rounded corners matching the app's cards,
 * hairline borders, quieter group titles and connectors, and no glow. Appended after Mermaid's own
 * styles inside the diagram's scope, so it takes precedence over them.
 */
const DIAGRAM_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; filter: none; }
  .node rect { rx: 10px; ry: 10px; }
  .cluster rect { rx: 14px; ry: 14px; stroke-width: 1px; filter: none; }
  .cluster-label text, .cluster text { font-weight: 600; font-size: 13px; fill: var(--muted-foreground); }
  .edgePath .path, .flowchart-link { stroke-width: 1.25px; }
  .edgeLabel text, .edgeLabel tspan { fill: var(--muted-foreground); font-size: 13px; }
  .note, .actor, .labelBox, .activation0, .activation1, .activation2 { filter: none; }
  rect.actor { rx: 10px; ry: 10px; stroke-width: 1px; }
  rect.note { rx: 8px; ry: 8px; stroke-width: 1px; }
`

/** Draws one diagram with locked security options and strips executable or external SVG content. */
async function renderDiagram(
  id: string,
  source: string,
  palette: DiagramPalette
): Promise<string> {
  const { default: mermaid } = await import("mermaid")
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: "base",
    look: "classic",
    themeVariables: diagramThemeVariables(palette),
    themeCSS: DIAGRAM_CSS,
    fontFamily: palette.fontFamily,
    // Room between a group's title and its border and contents.
    flowchart: { subGraphTitleMargin: { top: 8, bottom: 4 } },
    maxTextSize: 50_000,
    // Diagram sources cannot override these with init directives, so every diagram keeps the app's look.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "theme",
      "look",
      "themeVariables",
      "themeCSS",
      "fontFamily",
    ],
  })
  const { svg } = await mermaid.render(id, source)
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "image", "animate", "set"],
    FORBID_ATTR: ["href", "xlink:href"],
  })
  // Preserve the diagram's natural text size; narrow replies scroll instead of shrinking labels.
  const document = new DOMParser().parseFromString(sanitized, "image/svg+xml")
  const diagram = document.documentElement
  diagram.style.maxWidth = "none"
  const width = Number(diagram.getAttribute("viewBox")?.split(/[\s,]+/)[2])
  if (Number.isFinite(width) && width > 0)
    diagram.setAttribute("width", String(width))
  return new XMLSerializer().serializeToString(diagram)
}

/** Shows loading, a diagram or a recoverable error; stale work cannot replace newer streamed content. */
export function MarkdownMermaid({
  source,
  children,
}: {
  source: string
  children: ReactNode
}) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const palette = useSyncExternalStore(
    subscribeToThemeAttributes,
    readPaletteSnapshot,
    readServerPaletteSnapshot
  )
  const [result, setResult] = useState<{
    source: string
    palette: string
    svg?: string
    failed?: boolean
  }>()

  useEffect(() => {
    if (!palette) return
    let cancelled = false
    const render = renderQueue
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return
        try {
          const svg = await renderDiagram(
            id,
            source,
            JSON.parse(palette) as DiagramPalette
          )
          if (!cancelled) setResult({ source, palette, svg })
        } catch {
          if (!cancelled) setResult({ source, palette, failed: true })
        }
      })
    renderQueue = render
    return () => {
      cancelled = true
    }
  }, [id, source, palette])

  // After a theme or accent change, the previous drawing stays up until its redraw lands, so it never
  // flashes back to the loading text.
  const current = result?.source === source ? result : undefined
  return (
    // Lesson questions quote a diagram by its source, which says what it shows.
    <div className="markdown-diagram" data-ask-text={source}>
      {current?.svg ? (
        <div className="relative">
          <div
            className="markdown-diagram-canvas"
            role="region"
            aria-label="Diagram"
            tabIndex={0}
            // Only library-generated SVG sanitized above reaches this HTML boundary.
            dangerouslySetInnerHTML={{ __html: current.svg }}
          />
          <div className="absolute top-0 right-0">
            <ExpandFigureButton title="Diagram">
              <div
                className="markdown-diagram-canvas markdown-diagram-expanded"
                // The same sanitized SVG, drawn to fill the dialog.
                dangerouslySetInnerHTML={{ __html: current.svg }}
              />
            </ExpandFigureButton>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          {current?.failed
            ? "This diagram could not be rendered. View its source below."
            : "Rendering diagram…"}
        </p>
      )}
      {current?.failed ? (
        children
      ) : (
        <details className="markdown-diagram-source">
          <summary>View diagram source</summary>
          {children}
        </details>
      )}
    </div>
  )
}
