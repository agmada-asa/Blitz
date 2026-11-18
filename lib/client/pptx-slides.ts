/**
 * Reads a PowerPoint presentation (`.pptx`) into a simple slide model the
 * source reader can draw, so a cited slide is shown as a slide rather than as
 * extracted text.
 *
 * This is a reader for study material, not a full PowerPoint renderer. It
 * keeps what carries meaning in lecture slides: positioned text with its
 * size, weight, colour, bullets and levels; pictures; tables; solid shape
 * fills; and the background. Positions, sizes and styles that slides inherit
 * from their layout and master are resolved, and theme colours are applied.
 * Charts, SmartArt, effects, gradients and vector-only pictures (EMF/WMF) are
 * left out.
 *
 * Slides are numbered by their part name (`slide7.xml` is Slide 7), the same
 * rule extraction uses for `[Slide N]` markers in
 * `lib/server/source-ingestion/extract.ts`, so a citation and the drawn slide
 * always agree. Runs in the browser: it needs `DOMParser` and `URL.createObjectURL`.
 */

import { unzipSync } from "fflate"

/** Largest presentation file read in the browser. Matches the import limit for PowerPoint. */
export const MAX_PPTX_BYTES = 20_000_000

/** Largest total of uncompressed parts kept from one presentation. */
const MAX_UNZIPPED_BYTES = 80_000_000

/** Largest single picture kept; bigger media (videos, huge photos) are skipped. */
const MAX_MEDIA_BYTES = 10_000_000

/** English Metric Units in one point (1 inch is 914 400 EMU and 72 pt). */
const EMU_PER_POINT = 12_700

/** Picture formats a browser can draw, by file extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
}

/** A rectangle as fractions of the slide's width and height. */
export type SlideBox = { x: number; y: number; width: number; height: number }

/** A run of text with one set of character formatting. */
export type SlideRun = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** Font size in points, after any shrink-to-fit scaling. */
  size: number
  /** CSS colour, when the slide sets or inherits one. */
  color?: string
}

/** One paragraph of a text box or table cell. */
export type SlideParagraph = {
  /** Outline level, from 0. */
  level: number
  /** Bullet text drawn before the paragraph (`•`, `1.`), if any. */
  bullet?: string
  align: "left" | "center" | "right" | "justify"
  /** Left margin in points, including the bullet's hanging indent. */
  indent: number
  /** Space before the paragraph in points. */
  spaceBefore: number
  runs: SlideRun[]
}

/** Inner padding of a text box in points. */
export type SlideInsets = {
  top: number
  right: number
  bottom: number
  left: number
}

/** A drawable element on a slide. */
export type SlideShape =
  | {
      kind: "text"
      box: SlideBox
      fill?: string
      anchor: "top" | "middle" | "bottom"
      insets: SlideInsets
      paragraphs: SlideParagraph[]
    }
  | { kind: "image"; box: SlideBox; src: string; alt: string }
  | {
      kind: "table"
      box: SlideBox
      rows: Array<Array<{ fill?: string; paragraphs: SlideParagraph[] }>>
    }

/** One slide, ready to draw. */
export type Slide = {
  /** Slide number used by citations (from the part name). */
  number: number
  background?: string
  backgroundImage?: string
  shapes: SlideShape[]
}

/** A whole presentation, with the object URLs its pictures use. */
export type SlideDeck = {
  /** Slide width in points; font sizes are drawn relative to it. */
  widthPoints: number
  /** Width divided by height. */
  aspectRatio: number
  slides: Slide[]
  /** Releases the pictures' object URLs. Call when the deck is no longer shown. */
  dispose: () => void
}

/** Returns an element's direct children with the given local name. */
function children(element: Element | null | undefined, name: string): Element[] {
  if (!element) return []
  return Array.from(element.children).filter((child) => child.localName === name)
}

/** Follows a path of direct children by local name, returning the first match or null. */
function child(element: Element | null | undefined, ...path: string[]): Element | null {
  let current: Element | null = element ?? null
  for (const name of path) {
    current = children(current, name)[0] ?? null
    if (!current) return null
  }
  return current
}

/** Reads a numeric attribute, or undefined when it is missing or not a number. */
function numberAttribute(element: Element | null, name: string): number | undefined {
  const value = element?.getAttribute(name)
  if (value === null || value === undefined || value === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** Resolves a relationship target against the folder of the part that refers to it. */
function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts = fromPart.split("/").slice(0, -1)
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop()
    else if (segment && segment !== ".") parts.push(segment)
  }
  return parts.join("/")
}

/** A parsed XML part with its relationships. */
type Part = {
  path: string
  root: Element
  /** Relationship id → resolved part path, for internal targets only. */
  rels: Map<string, { type: string; path: string }>
}

/** Theme colours by scheme name, after the master's colour map is applied. */
type ColorScheme = Map<string, string>

/** Placeholder identity used to inherit position and style from the layout and master. */
type Placeholder = { type: string; idx?: string }

/** A shape from a layout or master that a slide placeholder inherits from. */
type InheritedShape = { shape: Element; part: Part }

/** Everything a slide needs from its layout and master. */
type SlideContext = {
  slide: Part
  layout?: Part
  master?: Part
  colors: ColorScheme
}

/**
 * Parses a PowerPoint file into drawable slides.
 *
 * @param bytes The `.pptx` file.
 * @returns The deck; call `dispose` when it is no longer shown.
 * @throws Error with a reader-facing message when the file is too large,
 *   is not a presentation, or has no slides.
 */
export function parsePptx(bytes: Uint8Array): SlideDeck {
  if (bytes.byteLength > MAX_PPTX_BYTES)
    throw new Error("This presentation is too large to show here.")
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        const name = entry.name
        const wanted =
          /^ppt\/(presentation\.xml|(slides|slideLayouts|slideMasters|theme)\/(_rels\/)?[^/]+\.(xml|rels))$/i.test(
            name
          ) ||
          (/^ppt\/media\/[^/]+$/i.test(name) &&
            entry.originalSize <= MAX_MEDIA_BYTES &&
            Boolean(IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""]))
        if (!wanted) return false
        total += entry.originalSize
        if (total > MAX_UNZIPPED_BYTES)
          throw new Error("This presentation is too large to show here.")
        return true
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large")) throw error
    throw new Error("This presentation could not be read.")
  }
  const decoder = new TextDecoder()
  const parser = new DOMParser()
  const parts = new Map<string, Part>()
  const objectUrls = new Map<string, string>()

  /** Parses a part and its relationships once; undefined when it is missing or malformed. */
  const part = (path: string): Part | undefined => {
    const cached = parts.get(path)
    if (cached) return cached
    const data = files[path]
    if (!data) return undefined
    const document = parser.parseFromString(decoder.decode(data), "application/xml")
    if (document.getElementsByTagName("parsererror").length) return undefined
    const rels = new Map<string, { type: string; path: string }>()
    const folder = path.split("/").slice(0, -1).join("/")
    const relsData = files[`${folder}/_rels/${path.split("/").pop()}.rels`]
    if (relsData) {
      const relsDocument = parser.parseFromString(
        decoder.decode(relsData),
        "application/xml"
      )
      for (const rel of Array.from(relsDocument.getElementsByTagName("Relationship"))) {
        if (rel.getAttribute("TargetMode") === "External") continue
        const id = rel.getAttribute("Id")
        const target = rel.getAttribute("Target")
        if (id && target)
          rels.set(id, {
            type: rel.getAttribute("Type") ?? "",
            path: resolvePartPath(path, target),
          })
      }
    }
    const parsed = { path, root: document.documentElement, rels }
    parts.set(path, parsed)
    return parsed
  }

  /** Returns an object URL for a picture part, creating it once. */
  const imageUrl = (path: string): string | undefined => {
    const existing = objectUrls.get(path)
    if (existing) return existing
    const data = files[path]
    const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""]
    if (!data || !type) return undefined
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
    objectUrls.set(path, url)
    return url
  }

  const presentation = part("ppt/presentation.xml")
  if (!presentation) throw new Error("This file is not a PowerPoint presentation.")
  const size = child(presentation.root, "sldSz")
  const width = numberAttribute(size, "cx") ?? 12_192_000
  const height = numberAttribute(size, "cy") ?? 6_858_000

  const slidePaths = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  if (!slidePaths.length) throw new Error("This presentation has no slides.")

  const slides: Slide[] = []
  for (const path of slidePaths) {
    const slide = part(path)
    if (!slide) continue
    const layout = relatedPart(slide, "slideLayout", part)
    const master = layout ? relatedPart(layout, "slideMaster", part) : undefined
    const theme = master ? relatedPart(master, "theme", part) : undefined
    const context: SlideContext = {
      slide,
      layout,
      master,
      colors: colorScheme(theme, master),
    }
    slides.push(
      readSlide(context, slideNumber(path), { width, height }, imageUrl)
    )
  }
  return {
    widthPoints: width / EMU_PER_POINT,
    aspectRatio: width / height,
    slides,
    dispose: () => {
      for (const url of objectUrls.values()) URL.revokeObjectURL(url)
      objectUrls.clear()
    },
  }
}

/** Reads the number in a `slideN.xml` part name. */
function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(path)?.[1] ?? 0)
}

/** Follows the first relationship of a type (`slideLayout`, `slideMaster`, `theme`). */
function relatedPart(
  from: Part,
  type: string,
  part: (path: string) => Part | undefined
): Part | undefined {
  for (const rel of from.rels.values())
    if (rel.type.endsWith(`/${type}`)) return part(rel.path)
  return undefined
}

/**
 * Builds the slide's colour names from the theme, applying the master's
 * colour map so `tx1`/`bg1` mean what the master says (usually `dk1`/`lt1`).
 */
function colorScheme(theme: Part | undefined, master: Part | undefined): ColorScheme {
  const colors: ColorScheme = new Map()
  const scheme = theme?.root.getElementsByTagNameNS("*", "clrScheme")[0]
  for (const entry of Array.from(scheme?.children ?? [])) {
    const value =
      child(entry, "srgbClr")?.getAttribute("val") ??
      child(entry, "sysClr")?.getAttribute("lastClr")
    if (value) colors.set(entry.localName, `#${value}`)
  }
  const map = child(master?.root, "clrMap")
  const defaults: Record<string, string> = {
    bg1: "lt1",
    tx1: "dk1",
    bg2: "lt2",
    tx2: "dk2",
  }
  for (const name of [
    "bg1",
    "tx1",
    "bg2",
    "tx2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ]) {
    const mapped = map?.getAttribute(name) ?? defaults[name] ?? name
    const value = colors.get(mapped)
    if (value) colors.set(name, value)
  }
  return colors
}

/**
 * Reads a colour from an element holding one colour choice (`a:solidFill`,
 * a style reference, `a:bgRef`), applying simple brightness changes.
 * Returns undefined for anything without a plain colour.
 */
function readColor(
  holder: Element | null | undefined,
  colors: ColorScheme
): string | undefined {
  if (!holder) return undefined
  const srgb = child(holder, "srgbClr")
  const scheme = child(holder, "schemeClr")
  const system = child(holder, "sysClr")
  const choice = srgb ?? scheme ?? system
  if (!choice) return undefined
  const base = srgb
    ? `#${srgb.getAttribute("val")}`
    : system
      ? `#${system.getAttribute("lastClr") ?? "000000"}`
      : colors.get(scheme?.getAttribute("val") ?? "")
  if (!base || !/^#[0-9a-f]{6}$/i.test(base)) return undefined
  // lumMod/lumOff (tints and shades of theme colours) are common in templates.
  const lumMod = (numberAttribute(child(choice, "lumMod"), "val") ?? 100_000) / 100_000
  const lumOff = (numberAttribute(child(choice, "lumOff"), "val") ?? 0) / 100_000
  const alpha = numberAttribute(child(choice, "alpha"), "val")
  if (lumMod === 1 && lumOff === 0 && alpha === undefined) return base
  const channels = [1, 3, 5].map((start) => parseInt(base.slice(start, start + 2), 16))
  const adjusted = channels.map((value) =>
    Math.round(Math.min(255, Math.max(0, value * lumMod + 255 * lumOff)))
  )
  return alpha === undefined
    ? `rgb(${adjusted.join(" ")})`
    : `rgb(${adjusted.join(" ")} / ${alpha / 100_000})`
}

/** Reads a solid or first gradient-stop fill from shape properties. */
function readFill(properties: Element | null, colors: ColorScheme): string | undefined {
  if (!properties || child(properties, "noFill")) return undefined
  const solid = child(properties, "solidFill")
  if (solid) return readColor(solid, colors)
  const stop = child(properties, "gradFill", "gsLst", "gs")
  return stop ? readColor(stop, colors) : undefined
}

/** Reads a placeholder's type and index, or undefined for an ordinary shape. */
function placeholderOf(shape: Element): Placeholder | undefined {
  const properties =
    child(shape, "nvSpPr", "nvPr") ??
    child(shape, "nvPicPr", "nvPr") ??
    child(shape, "nvGraphicFramePr", "nvPr")
  const placeholder = child(properties, "ph")
  if (!placeholder) return undefined
  return {
    type: placeholder.getAttribute("type") ?? "body",
    idx: placeholder.getAttribute("idx") ?? undefined,
  }
}

/** Placeholder types that share a style family, for matching across layout and master. */
function placeholderFamily(type: string): string {
  if (type === "ctrTitle" || type === "title") return "title"
  if (type === "subTitle" || type === "body" || type === "obj") return "body"
  return type
}

/** Finds the shape in a layout or master that a slide placeholder inherits from. */
function findPlaceholder(
  owner: Part | undefined,
  placeholder: Placeholder
): InheritedShape | undefined {
  if (!owner) return undefined
  const tree = child(owner.root, "cSld", "spTree")
  const shapes = Array.from(tree?.getElementsByTagNameNS("*", "sp") ?? [])
  const withPlaceholders = shapes
    .map((shape) => ({ shape, placeholder: placeholderOf(shape) }))
    .filter((item) => item.placeholder)
  const byIndex =
    placeholder.idx !== undefined
      ? withPlaceholders.find((item) => item.placeholder?.idx === placeholder.idx)
      : undefined
  const byType = withPlaceholders.find(
    (item) =>
      item.placeholder?.type === placeholder.type ||
      placeholderFamily(item.placeholder?.type ?? "") ===
        placeholderFamily(placeholder.type)
  )
  const found = byIndex ?? byType
  return found ? { shape: found.shape, part: owner } : undefined
}

/** Reads `off`/`ext` from a transform element, in EMU. */
function readTransform(transform: Element | null) {
  const offset = child(transform, "off")
  const extent = child(transform, "ext")
  if (!offset || !extent) return undefined
  return {
    x: numberAttribute(offset, "x") ?? 0,
    y: numberAttribute(offset, "y") ?? 0,
    width: numberAttribute(extent, "cx") ?? 0,
    height: numberAttribute(extent, "cy") ?? 0,
  }
}

/** Maps a rectangle in a group's child coordinates to slide coordinates (EMU). */
type CoordinateMap = (rect: { x: number; y: number; width: number; height: number }) => {
  x: number
  y: number
  width: number
  height: number
}

/** Bundles slide size with a coordinate map for the current group. */
type Geometry = { width: number; height: number; map: CoordinateMap }

/** Converts a mapped EMU rectangle into fractions of the slide. */
function toBox(
  rect: { x: number; y: number; width: number; height: number },
  geometry: Geometry
): SlideBox {
  const mapped = geometry.map(rect)
  return {
    x: mapped.x / geometry.width,
    y: mapped.y / geometry.height,
    width: mapped.width / geometry.width,
    height: mapped.height / geometry.height,
  }
}

/** Reads the drawn elements of one slide, with its layout and master behind it. */
function readSlide(
  context: SlideContext,
  number: number,
  size: { width: number; height: number },
  imageUrl: (path: string) => string | undefined
): Slide {
  const geometry: Geometry = { ...size, map: (rect) => rect }
  const shapes: SlideShape[] = []
  // Masters and layouts draw their own decoration (logos, bars) unless a slide hides it.
  const showMaster = (owner: Part | undefined) =>
    owner?.root.getAttribute("showMasterSp") !== "0"
  if (showMaster(context.slide) && showMaster(context.layout) && context.master)
    readTree(context.master, context, geometry, imageUrl, shapes, true)
  if (showMaster(context.slide) && context.layout)
    readTree(context.layout, context, geometry, imageUrl, shapes, true)
  readTree(context.slide, context, geometry, imageUrl, shapes, false)

  // The first part, from slide to master, that sets a background wins.
  let background: string | undefined
  let backgroundImage: string | undefined
  for (const owner of [context.slide, context.layout, context.master]) {
    const bg = child(owner?.root, "cSld", "bg")
    if (!owner || !bg) continue
    const properties = child(bg, "bgPr")
    const blip = child(properties, "blipFill", "blip")
    const embed = blip?.getAttribute("r:embed")
    const target = embed ? owner.rels.get(embed) : undefined
    if (target) backgroundImage = imageUrl(target.path)
    background =
      readFill(properties, context.colors) ?? readColor(child(bg, "bgRef"), context.colors)
    if (background || backgroundImage) break
  }
  return {
    number,
    background: background ?? context.colors.get("bg1"),
    backgroundImage,
    shapes,
  }
}

/**
 * Reads the shape tree of a slide, layout or master into `shapes`.
 *
 * @param decorationOnly For layouts and masters: skip placeholders, which
 *   only describe where the slide's own content goes.
 */
function readTree(
  owner: Part,
  context: SlideContext,
  geometry: Geometry,
  imageUrl: (path: string) => string | undefined,
  shapes: SlideShape[],
  decorationOnly: boolean,
  tree: Element | null = child(owner.root, "cSld", "spTree")
): void {
  for (const element of Array.from(tree?.children ?? [])) {
    if (decorationOnly && placeholderOf(element)) continue
    if (element.localName === "grpSp") {
      const transform = child(element, "grpSpPr", "xfrm")
      const outer = readTransform(transform)
      const childOffset = child(transform, "chOff")
      const childExtent = child(transform, "chExt")
      if (!outer || !childOffset || !childExtent) {
        readTree(owner, context, geometry, imageUrl, shapes, decorationOnly, element)
        continue
      }
      const chX = numberAttribute(childOffset, "x") ?? 0
      const chY = numberAttribute(childOffset, "y") ?? 0
      const scaleX = outer.width / (numberAttribute(childExtent, "cx") || outer.width || 1)
      const scaleY = outer.height / (numberAttribute(childExtent, "cy") || outer.height || 1)
      const parentMap = geometry.map
      const map: CoordinateMap = (rect) =>
        parentMap({
          x: outer.x + (rect.x - chX) * scaleX,
          y: outer.y + (rect.y - chY) * scaleY,
          width: rect.width * scaleX,
          height: rect.height * scaleY,
        })
      readTree(owner, context, { ...geometry, map }, imageUrl, shapes, decorationOnly, element)
    } else if (element.localName === "sp") {
      const shape = readTextShape(element, owner, context, geometry)
      if (shape) shapes.push(shape)
    } else if (element.localName === "pic") {
      const placeholder = placeholderOf(element)
      const inherited = placeholder
        ? (findPlaceholder(context.layout, placeholder) ??
          findPlaceholder(context.master, placeholder))
        : undefined
      const rect =
        readTransform(child(element, "spPr", "xfrm")) ??
        readTransform(child(inherited?.shape, "spPr", "xfrm"))
      const embed = child(element, "blipFill", "blip")?.getAttribute("r:embed")
      const target = embed ? owner.rels.get(embed) : undefined
      const src = target ? imageUrl(target.path) : undefined
      if (rect && src)
        shapes.push({
          kind: "image",
          box: toBox(rect, geometry),
          src,
          alt: child(element, "nvPicPr", "cNvPr")?.getAttribute("descr") ?? "",
        })
    } else if (element.localName === "graphicFrame") {
      const table = element.getElementsByTagNameNS("*", "tbl")[0]
      const rect = readTransform(child(element, "xfrm"))
      if (!table || !rect) continue
      shapes.push({
        kind: "table",
        box: toBox(rect, geometry),
        rows: children(table, "tr").map((row) =>
          children(row, "tc").map((cell) => ({
            fill: readFill(child(cell, "tcPr"), context.colors),
            paragraphs: readParagraphs(child(cell, "txBody"), [], context, 1, 14),
          }))
        ),
      })
    }
  }
}

/** Reads a text shape, inheriting position and styles from its placeholder. */
function readTextShape(
  shape: Element,
  owner: Part,
  context: SlideContext,
  geometry: Geometry
): SlideShape | undefined {
  const placeholder = placeholderOf(shape)
  const fromLayout =
    placeholder && owner === context.slide
      ? findPlaceholder(context.layout, placeholder)
      : undefined
  const fromMaster =
    placeholder && owner !== context.master
      ? findPlaceholder(context.master, placeholder)
      : undefined
  const chain = [shape, fromLayout?.shape, fromMaster?.shape].filter(
    (item): item is Element => Boolean(item)
  )
  const rect = chain
    .map((item) => readTransform(child(item, "spPr", "xfrm")))
    .find(Boolean)
  if (!rect) return undefined
  const body = child(shape, "txBody")
  const bodyProperties = chain.map((item) => child(item, "txBody", "bodyPr"))
  const anchorValue = bodyProperties
    .map((item) => item?.getAttribute("anchor"))
    .find(Boolean)
  // Shrink-to-fit scales every font in the box; PowerPoint saves the scale it used.
  const fontScale =
    (numberAttribute(child(bodyProperties[0], "normAutofit"), "fontScale") ?? 100_000) /
    100_000
  // Text styles, most specific first: the shape, its layout and master
  // placeholders, then the master's title, body or other text style.
  const family = placeholder ? placeholderFamily(placeholder.type) : undefined
  const masterStyle = child(
    context.master?.root,
    "txStyles",
    // Slide numbers, dates and footers use the plain text style, not the body's bullets.
    family === "title" ? "titleStyle" : family === "body" ? "bodyStyle" : "otherStyle"
  )
  const styles = [
    ...chain.map((item) => child(item, "txBody", "lstStyle")),
    masterStyle,
  ].filter((item): item is Element => Boolean(item))
  // A drawn shape (not a text box) takes its fill and text colour from its
  // style when its own properties set none: accent fill with light text.
  const style = child(shape, "style")
  const ownProperties = child(shape, "spPr")
  const fill =
    chain.map((item) => readFill(child(item, "spPr"), context.colors)).find(Boolean) ??
    (child(ownProperties, "noFill")
      ? undefined
      : readColor(child(style, "fillRef"), context.colors))
  const paragraphs = readParagraphs(
    body,
    styles,
    context,
    fontScale,
    family === "title" ? 40 : 18,
    readColor(child(style, "fontRef"), context.colors)
  )
  if (!paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text.trim())) && !fill)
    return undefined
  /** Reads one inset in points, falling back to PowerPoint's default. */
  const inset = (name: string, fallback: number) =>
    (bodyProperties
      .map((item) => numberAttribute(item, name))
      .find((value) => value !== undefined) ?? fallback) / EMU_PER_POINT
  return {
    kind: "text",
    box: toBox(rect, geometry),
    fill,
    anchor: anchorValue === "ctr" ? "middle" : anchorValue === "b" ? "bottom" : "top",
    insets: {
      top: inset("tIns", 45_720),
      right: inset("rIns", 91_440),
      bottom: inset("bIns", 45_720),
      left: inset("lIns", 91_440),
    },
    paragraphs,
  }
}

/**
 * Reads the paragraphs of a text body.
 *
 * @param styles List styles to inherit from, most specific first.
 * @param fontScale Shrink-to-fit scale applied to every size.
 * @param fallbackSize Font size in points when nothing sets one.
 * @param fallbackColor Text colour from the shape's style, used before the
 *   theme's text colour.
 */
function readParagraphs(
  body: Element | null,
  styles: Element[],
  context: SlideContext,
  fontScale: number,
  fallbackSize: number,
  fallbackColor?: string
): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = []
  const numbering = new Map<number, number>()
  for (const paragraph of children(body, "p")) {
    const properties = child(paragraph, "pPr")
    const level = numberAttribute(properties, "lvl") ?? 0
    const levelStyles = [
      properties,
      ...styles.map((style) => child(style, `lvl${level + 1}pPr`)),
    ].filter((item): item is Element => Boolean(item))
    /** First value a paragraph or its inherited styles give. */
    const inherited = <T,>(read: (style: Element) => T | undefined) =>
      levelStyles.map(read).find((value) => value !== undefined)
    const defaults = levelStyles.map((style) => child(style, "defRPr"))
    const size =
      ((defaults.map((item) => numberAttribute(item, "sz")).find(Boolean) ?? fallbackSize * 100) /
        100) *
      fontScale
    const defaultColor = defaults
      .map((item) => readColor(child(item, "solidFill"), context.colors))
      .find(Boolean)
    const defaultBold = defaults.map((item) => item?.getAttribute("b")).find((value) => value !== null && value !== undefined)
    const runs: SlideRun[] = []
    for (const run of Array.from(paragraph.children)) {
      if (run.localName === "br") {
        runs.push({ text: "\n", size })
        continue
      }
      if (run.localName !== "r" && run.localName !== "fld") continue
      const runProperties = child(run, "rPr")
      const text = child(run, "t")?.textContent ?? ""
      if (!text) continue
      const runSize = numberAttribute(runProperties, "sz")
      const bold = runProperties?.getAttribute("b") ?? defaultBold
      runs.push({
        text,
        size: runSize ? (runSize / 100) * fontScale : size,
        bold: bold === "1" || bold === "true",
        italic: ["1", "true"].includes(runProperties?.getAttribute("i") ?? ""),
        underline: Boolean(runProperties?.getAttribute("u") && runProperties.getAttribute("u") !== "none"),
        color:
          readColor(child(runProperties, "solidFill"), context.colors) ??
          // A drawn shape's style colour beats the master's text style.
          fallbackColor ??
          defaultColor ??
          context.colors.get("tx1"),
      })
    }
    // Bullets: the paragraph or its styles choose none, a character, or numbering.
    const bulletStyle = inherited((style) =>
      child(style, "buNone")
        ? "none"
        : child(style, "buChar")
          ? `char:${child(style, "buChar")?.getAttribute("char") ?? "•"}`
          : child(style, "buAutoNum")
            ? "number"
            : undefined
    )
    let bullet: string | undefined
    const hasText = runs.some((run) => run.text.trim())
    if (bulletStyle === "number" && hasText) {
      const next = (numbering.get(level) ?? 0) + 1
      numbering.set(level, next)
      bullet = `${next}.`
    } else {
      numbering.delete(level)
      if (bulletStyle?.startsWith("char:") && hasText) bullet = bulletStyle.slice(5)
    }
    const align = inherited((style) => style.getAttribute("algn") ?? undefined)
    const marginLeft = inherited((style) => numberAttribute(style, "marL"))
    const spaceBefore = inherited((style) =>
      numberAttribute(child(style, "spcBef", "spcPts"), "val")
    )
    paragraphs.push({
      level,
      bullet,
      align:
        align === "ctr" ? "center" : align === "r" ? "right" : align === "just" ? "justify" : "left",
      indent: (marginLeft ?? (bullet ? (level + 1) * 342_900 : level * 342_900)) / EMU_PER_POINT,
      spaceBefore: ((spaceBefore ?? 0) / 100) * fontScale,
      runs: runs.length ? runs : [{ text: "", size }],
    })
  }
  return paragraphs
}
