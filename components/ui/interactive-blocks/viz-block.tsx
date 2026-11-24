"use client"

/**
 * Renders a model-authored interactive visualisation from a ```viz Markdown block.
 *
 * The HTML runs only inside an iframe with `sandbox="allow-scripts"` (never `allow-same-origin`), so it
 * gets an opaque origin with no access to the app, its cookies, or storage. `buildVizDocument` adds a
 * Content Security Policy that blocks all network access, the app's theme colours, font and control
 * styles, and a bridge script
 * that reports content height. Height messages are trusted only when they come from this iframe's own
 * window. Theme changes are posted into the running frame so interactive state survives a theme switch.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useTheme } from "next-themes"
import {
  buildVizDocument,
  VIZ_HEIGHT_MESSAGE,
  VIZ_THEME_MESSAGE,
  vizThemeDeclarations,
  type VizBlock,
  type VizTheme,
} from "@/lib/interactive-blocks"
import { Skeleton } from "@/components/ui/skeleton"
import { ExpandFigureButton } from "@/components/ui/interactive-blocks/expand-figure"
import { subscribeToThemeAttributes } from "@/lib/client/theme-attributes"

/** Iframe height bounds in CSS pixels; taller content scrolls inside the frame. */
const MIN_HEIGHT = 120
const MAX_HEIGHT = 900
/** Taller limit for the "Open larger" view, which scrolls inside the dialog beyond it. */
const EXPANDED_MAX_HEIGHT = 2400
/** Height used if the frame never reports one, for example when its HTML breaks the bridge script. */
const FALLBACK_HEIGHT = 320
/** How long to wait for the first height report before showing the frame at the fallback height. */
const HEIGHT_TIMEOUT_MS = 4000

/**
 * The app font as a data URL, loaded once on first use so its 40 KB stay out
 * of the main bundle. Undefined while loading; empty if the load failed, in
 * which case frames use a system font.
 */
let vizFont: string | undefined
let vizFontLoad: Promise<string> | undefined

/**
 * Loads the embedded app font for visualisation frames.
 * @returns The font's data URL, or an empty string if it could not load.
 */
function loadVizFont(): Promise<string> {
  vizFontLoad ??= import("@/lib/viz-font").then(
    (module) => (vizFont = module.VIZ_FONT_DATA_URL),
    () => (vizFont = "")
  )
  return vizFontLoad
}

/**
 * Tracks the embedded app font, so a frame is built once the font is ready.
 * @returns The font's data URL, empty if it failed, or undefined while loading.
 */
function useVizFont(): string | undefined {
  const [font, setFont] = useState(vizFont)
  useEffect(() => {
    if (font !== undefined) return
    let active = true
    void loadVizFont().then((loaded) => {
      if (active) setFont(loaded)
    })
    return () => {
      active = false
    }
  }, [font])
  return font
}


/**
 * Reads the resolved app palette and font as a string snapshot so React can compare it cheaply.
 * @returns JSON of the theme values other than `dark`.
 */
function readThemeSnapshot(): string {
  const root = getComputedStyle(document.documentElement)
  const value = (name: string) => root.getPropertyValue(name).trim()
  return JSON.stringify({
    background: value("--background"),
    foreground: value("--foreground"),
    card: value("--card"),
    muted: value("--muted"),
    mutedForeground: value("--muted-foreground"),
    border: value("--border"),
    input: value("--input"),
    ring: value("--ring"),
    brand: value("--brand"),
    brandForeground: value("--brand-foreground"),
    primary: value("--primary"),
    primaryForeground: value("--primary-foreground"),
    accent: value("--accent"),
    accentForeground: value("--accent-foreground"),
    radius: value("--radius"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  } satisfies Omit<VizTheme, "dark">)
}

/**
 * Returns an empty snapshot on the server and during hydration, so the frame is created only on the client.
 * @returns An empty string.
 */
function readServerThemeSnapshot(): string {
  return ""
}

/**
 * Tracks the current app theme for visualisation frames.
 * @returns The resolved theme, or undefined before the client has mounted.
 */
function useVizTheme(): VizTheme | undefined {
  const { resolvedTheme } = useTheme()
  const snapshot = useSyncExternalStore(
    subscribeToThemeAttributes,
    readThemeSnapshot,
    readServerThemeSnapshot
  )
  return useMemo(
    () =>
      snapshot
        ? {
            dark: resolvedTheme === "dark",
            ...(JSON.parse(snapshot) as Omit<VizTheme, "dark">),
          }
        : undefined,
    [resolvedTheme, snapshot]
  )
}

/**
 * Renders one sandboxed visualisation with its title, an "Open larger" view, and an inspectable source
 * view.
 * @param block Validated visualisation block.
 * @param children Source view, normally the highlighted HTML code block.
 * @returns The titled, auto-sized visualisation frame.
 */
export function VizBlockView({
  block,
  children,
}: {
  block: VizBlock
  children: ReactNode
}) {
  const title = block.title ?? "Interactive visualisation"
  return (
    <figure className="interactive-block min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        {block.title ? (
          <figcaption className="font-medium">{block.title}</figcaption>
        ) : (
          <span />
        )}
        {/* The larger view is a fresh frame, so it starts from the visualisation's initial state. */}
        <ExpandFigureButton title={title}>
          <VizFrame block={block} maxHeight={EXPANDED_MAX_HEIGHT} />
        </ExpandFigureButton>
      </div>
      <VizFrame block={block} maxHeight={MAX_HEIGHT} />
      <details className="markdown-diagram-source">
        <summary>View source</summary>
        {children}
      </details>
    </figure>
  )
}

/**
 * Runs one visualisation in its sandboxed, auto-sized frame with a loading state.
 * @param block Validated visualisation block.
 * @param maxHeight Tallest the frame grows before its content scrolls inside it.
 * @returns The bordered frame.
 */
function VizFrame({ block, maxHeight }: { block: VizBlock; maxHeight: number }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const theme = useVizTheme()
  const font = useVizFont()
  const themeCss = theme ? vizThemeDeclarations(theme) : ""
  const latestThemeCss = useRef(themeCss)
  const [frame, setFrame] = useState<{ html: string; srcdoc: string }>()
  const [measured, setMeasured] = useState<{
    srcdoc: string
    height: number
  }>()

  // Build the document once per HTML change; later theme changes are posted into the running frame.
  if (theme && font !== undefined && frame?.html !== block.html)
    setFrame({
      html: block.html,
      srcdoc: buildVizDocument(block.html, theme, font),
    })

  const srcdoc = frame?.html === block.html ? frame.srcdoc : undefined
  const height = measured?.srcdoc === srcdoc ? measured?.height : undefined
  const title = block.title ?? "Interactive visualisation"

  useEffect(() => {
    latestThemeCss.current = themeCss
    if (themeCss)
      iframeRef.current?.contentWindow?.postMessage(
        { type: VIZ_THEME_MESSAGE, css: themeCss },
        "*"
      )
  }, [themeCss])

  useEffect(() => {
    if (!srcdoc) return
    const frameDocument = srcdoc
    /** Accepts height reports only from this frame's window, clamped to the allowed range. */
    function receiveHeight(event: MessageEvent) {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      const data: unknown = event.data
      if (
        !data ||
        typeof data !== "object" ||
        (data as { type?: unknown }).type !== VIZ_HEIGHT_MESSAGE
      )
        return
      const reported = (data as { height?: unknown }).height
      if (typeof reported !== "number" || !Number.isFinite(reported)) return
      const next = Math.min(
        maxHeight,
        Math.max(MIN_HEIGHT, Math.ceil(reported))
      )
      setMeasured((current) =>
        current?.srcdoc === frameDocument && current.height === next
          ? current
          : { srcdoc: frameDocument, height: next }
      )
    }
    window.addEventListener("message", receiveHeight)
    const timeout = window.setTimeout(
      () =>
        setMeasured((current) =>
          current?.srcdoc === frameDocument
            ? current
            : { srcdoc: frameDocument, height: FALLBACK_HEIGHT }
        ),
      HEIGHT_TIMEOUT_MS
    )
    return () => {
      window.removeEventListener("message", receiveHeight)
      window.clearTimeout(timeout)
    }
  }, [srcdoc, maxHeight])

  /** Re-sends the current theme after load, in case it changed while the frame was loading. */
  function syncThemeOnLoad() {
    if (latestThemeCss.current)
      iframeRef.current?.contentWindow?.postMessage(
        { type: VIZ_THEME_MESSAGE, css: latestThemeCss.current },
        "*"
      )
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-background">
        {srcdoc ? (
          <iframe
            ref={iframeRef}
            title={title}
            srcDoc={srcdoc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={syncThemeOnLoad}
            className="block w-full border-0"
            style={{ height: height ?? MIN_HEIGHT + 40 }}
          />
        ) : (
          <div style={{ height: MIN_HEIGHT + 40 }} />
        )}
        {height === undefined ? (
          <div
            className="absolute inset-0 space-y-3 bg-background p-4"
            role="status"
          >
            <p className="text-sm text-muted-foreground">
              Loading visualisation…
            </p>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : null}
    </div>
  )
}
