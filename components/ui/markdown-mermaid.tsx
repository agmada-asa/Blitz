"use client"

/** Lazily renders Mermaid diagrams locally, with sanitized SVG and an always available source view. */
import { useEffect, useId, useState, type ReactNode } from "react"
import { useTheme } from "next-themes"
import DOMPurify from "dompurify"

/** Serializes theme initialization and drawing because Mermaid has global configuration. */
let renderQueue: Promise<unknown> = Promise.resolve()

/** Draws one diagram with locked security options and strips executable or external SVG content. */
async function renderDiagram(
  id: string,
  source: string,
  dark: boolean
): Promise<string> {
  const { default: mermaid } = await import("mermaid")
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: dark ? "dark" : "default",
    fontFamily: "Instrument Sans Variable, sans-serif",
    maxTextSize: 50_000,
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "theme",
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
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const [result, setResult] = useState<{
    source: string
    dark: boolean
    svg?: string
    failed?: boolean
  }>()

  useEffect(() => {
    let cancelled = false
    const render = renderQueue
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return
        try {
          const svg = await renderDiagram(id, source, dark)
          if (!cancelled) setResult({ source, dark, svg })
        } catch {
          if (!cancelled) setResult({ source, dark, failed: true })
        }
      })
    renderQueue = render
    return () => {
      cancelled = true
    }
  }, [id, source, dark])

  const current =
    result?.source === source && result.dark === dark ? result : undefined
  return (
    <div className="markdown-diagram">
      {current?.svg ? (
        <div
          className="markdown-diagram-canvas"
          role="region"
          aria-label="Mermaid diagram"
          tabIndex={0}
          // Only library-generated SVG sanitized above reaches this HTML boundary.
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
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
