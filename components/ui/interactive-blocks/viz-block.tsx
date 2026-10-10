"use client"

/**
 * Renders a model-authored interactive visualisation from a ```viz Markdown block.
 *
 * The HTML runs only inside an iframe with `sandbox="allow-scripts"` (never `allow-same-origin`), so it
 * gets an opaque origin with no access to the app, its cookies, or storage. `buildVizDocument` adds a
 * Content Security Policy that blocks all network access, the app's theme colours, and a bridge script
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

/** Iframe height bounds in CSS pixels; taller content scrolls inside the frame. */
const MIN_HEIGHT = 120
const MAX_HEIGHT = 900
/** Height used if the frame never reports one, for example when its HTML breaks the bridge script. */
const FALLBACK_HEIGHT = 320
/** How long to wait for the first height report before showing the frame at the fallback height. */
const HEIGHT_TIMEOUT_MS = 4000

/**
 * Subscribes to theme and accent changes, which next-themes and settings apply as attributes on `<html>`.
 * @param onChange Called when a theme-relevant attribute changes.
 * @returns A function that stops observing.
 */
function subscribeToThemeAttributes(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-accent", "data-theme"],
  })
  return () => observer.disconnect()
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
    muted: value("--muted"),
    mutedForeground: value("--muted-foreground"),
    border: value("--border"),
    brand: value("--brand"),
    brandForeground: value("--brand-foreground"),
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
 * Renders one sandboxed visualisation with its title, a loading state, and an inspectable source view.
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
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const theme = useVizTheme()
  const themeCss = theme ? vizThemeDeclarations(theme) : ""
  const latestThemeCss = useRef(themeCss)
  const [frame, setFrame] = useState<{ html: string; srcdoc: string }>()
  const [measured, setMeasured] = useState<{
    srcdoc: string
    height: number
  }>()

  // Build the document once per HTML change; later theme changes are posted into the running frame.
  if (theme && frame?.html !== block.html)
    setFrame({ html: block.html, srcdoc: buildVizDocument(block.html, theme) })

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
        MAX_HEIGHT,
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
  }, [srcdoc])

  /** Re-sends the current theme after load, in case it changed while the frame was loading. */
  function syncThemeOnLoad() {
    if (latestThemeCss.current)
      iframeRef.current?.contentWindow?.postMessage(
        { type: VIZ_THEME_MESSAGE, css: latestThemeCss.current },
        "*"
      )
  }

  return (
    <figure className="interactive-block min-w-0">
      {block.title ? (
        <figcaption className="mb-2 font-medium">{block.title}</figcaption>
      ) : null}
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
      <details className="markdown-diagram-source">
        <summary>View source</summary>
        {children}
      </details>
    </figure>
  )
}
