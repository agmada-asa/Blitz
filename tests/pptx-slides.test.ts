/**
 * Checks the PowerPoint reader the source reader uses to draw cited slides
 * (`lib/client/pptx-slides.ts`): slide numbering, what slides inherit from
 * their layout, master and theme, groups, pictures, tables, bullets, colours
 * and the size limits.
 *
 * Decks are built in memory from small PresentationML parts. Node has no
 * `DOMParser`, so `@xmldom/xmldom` stands in for the browser's.
 */
import assert from "node:assert/strict"
import { resolveObjectURL } from "node:buffer"
import test from "node:test"
import { DOMParser } from "@xmldom/xmldom"
import { strToU8, zipSync } from "fflate"
import {
  MAX_PPTX_BYTES,
  parsePptx,
  SlideDeckError,
  type SlideDeck,
  type SlideParagraph,
  type SlideShape,
} from "../lib/client/pptx-slides.ts"

// The parser creates its `DOMParser` when called, so setting it here is enough.
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser

/** Namespace declarations shared by every slide, layout and master part. */
const NS = [
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(" ")

/** Prefix of every relationship type; the parser matches on the last segment. */
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

/** A 4:3 slide, 720 by 540 points, so boxes come out as round fractions. */
const PRESENTATION = `<p:presentation ${NS}><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`

/** Builds a relationships part from `[id, type, target]` entries. */
function rels(entries: Array<[string, string, string]>): string {
  const items = entries
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`
    )
    .join("")
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
}

/** An `a:xfrm` (or `p:xfrm`) box in EMU. */
function xfrm(x: number, y: number, cx: number, cy: number, prefix = "a"): string {
  return `<${prefix}:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></${prefix}:xfrm>`
}

/**
 * A text shape.
 *
 * @param placeholder Inner attributes of `p:ph`, or undefined for a plain text box.
 * @param body Paragraph XML (`a:p` elements).
 * @param extra Markup for `p:spPr` (usually a transform), `a:bodyPr`, and a `p:style`.
 */
function shape(
  placeholder: string | undefined,
  body: string,
  extra: { spPr?: string; bodyPr?: string; style?: string } = {}
): string {
  const ph = placeholder === undefined ? "" : `<p:ph ${placeholder}/>`
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${extra.spPr ?? ""}</p:spPr>${extra.style ?? ""}` +
    `<p:txBody><a:bodyPr>${extra.bodyPr ?? ""}</a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
  )
}

/** One paragraph with a single plain run. */
function paragraph(text: string, pPr = ""): string {
  return `<a:p>${pPr}<a:r><a:t>${text}</a:t></a:r></a:p>`
}

/** Theme with distinct dark, light and accent colours. `dk1` is a system colour. */
const THEME =
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1>` +
  `<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="223344"/></a:dk2>` +
  `<a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4080C0"/></a:accent1>` +
  `</a:clrScheme></a:themeElements></a:theme>`

/**
 * Master: a title placeholder (never drawn itself), a logo decoration, a
 * `bg2` background, and title and body text styles. Its colour map points
 * `tx1` at `dk2`, so text inheriting `tx1` must come out `#223344`.
 */
const MASTER =
  `<p:sldMaster ${NS}><p:cSld>` +
  `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg>` +
  `<p:spTree>` +
  shape('type="title"', paragraph("Master title"), { spPr: xfrm(0, 0, 100, 100) }) +
  shape(undefined, paragraph("Course logo"), { spPr: xfrm(0, 6400800, 914400, 457200) }) +
  `</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk2" bg2="lt2" tx2="dk1" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:txStyles>` +
  `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle>` +
  `<a:lvl1pPr marL="342900"><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr>` +
  `<a:lvl2pPr marL="685800"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr>` +
  `</p:bodyStyle>` +
  `</p:txStyles></p:sldMaster>`

/** Layout: where the title and the body placeholder (index 1) go. */
const LAYOUT =
  `<p:sldLayout ${NS}><p:cSld><p:spTree>` +
  shape('type="title"', "", { spPr: xfrm(914400, 685800, 7315200, 1371600) }) +
  shape('type="body" idx="1"', "", { spPr: xfrm(914400, 2743200, 7315200, 3429000) }) +
  `</p:spTree></p:cSld></p:sldLayout>`

/** Slide-to-layout relationships, plus any pictures the slide uses. */
function slideRels(...extra: Array<[string, string, string]>): string {
  return rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ...extra])
}

/**
 * Zips a presentation with the shared master, layout and theme.
 *
 * @param slides Slide part XML by part number (`slideN.xml`).
 * @param files Extra parts (relationships, media), by path.
 */
function deckBytes(
  slides: Record<number, string>,
  files: Record<string, string | Uint8Array> = {}
): Uint8Array {
  const parts: Record<string, string | Uint8Array> = {
    "ppt/presentation.xml": PRESENTATION,
    "ppt/slideMasters/slideMaster1.xml": MASTER,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([
      ["rId1", "theme", "../theme/theme1.xml"],
    ]),
    "ppt/slideLayouts/slideLayout1.xml": LAYOUT,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([
      ["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"],
    ]),
    "ppt/theme/theme1.xml": THEME,
  }
  for (const [number, xml] of Object.entries(slides)) {
    parts[`ppt/slides/slide${number}.xml`] = xml
    parts[`ppt/slides/_rels/slide${number}.xml.rels`] ??= slideRels()
  }
  Object.assign(parts, files)
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([path, data]) => [
        path,
        typeof data === "string" ? strToU8(data) : data,
      ])
    )
  )
}

/** Wraps shapes in a slide part. */
function slideXml(shapes: string, options: { attributes?: string; background?: string } = {}): string {
  return `<p:sld ${NS} ${options.attributes ?? ""}><p:cSld>${options.background ?? ""}<p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`
}

/** Joins paragraphs' runs into lines of text. */
function paragraphsText(paragraphs: SlideParagraph[]): string {
  return paragraphs.map((item) => item.runs.map((run) => run.text).join("")).join("\n")
}

/** The text of a shape, for finding shapes and checking what was drawn. */
function shapeText(shape: SlideShape): string {
  if (shape.kind === "image") return ""
  return paragraphsText(
    shape.kind === "text" ? shape.paragraphs : shape.rows.flat().flatMap((cell) => cell.paragraphs)
  )
}

/** Returns the text shape on a slide holding exactly `text`. */
function textShape(deck: SlideDeck, slide: number, text: string) {
  const found = deck.slides
    .find((item) => item.number === slide)
    ?.shapes.find((item) => item.kind === "text" && shapeText(item) === text)
  assert.ok(found && found.kind === "text", `no text shape "${text}" on slide ${slide}`)
  return found
}

/** Rounds box fractions so float noise does not fail comparisons. */
function rounded(box: SlideShape["box"]) {
  const round = (value: number) => Math.round(value * 10_000) / 10_000
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

test("slides are numbered by part name and sorted by number", () => {
  const deck = parsePptx(
    deckBytes({
      10: slideXml(shape(undefined, paragraph("Ten"), { spPr: xfrm(0, 0, 914400, 914400) })),
      2: slideXml(shape(undefined, paragraph("Two"), { spPr: xfrm(0, 0, 914400, 914400) })),
      1: slideXml(shape(undefined, paragraph("One"), { spPr: xfrm(0, 0, 914400, 914400) })),
    })
  )
  // `[Slide N]` markers in extraction use the same rule, so citations agree.
  assert.deepEqual(
    deck.slides.map((item) => item.number),
    [1, 2, 10]
  )
  assert.equal(deck.widthPoints, 720)
  assert.equal(deck.aspectRatio, 4 / 3)
  deck.dispose()
})

test("placeholders take position from the layout and style from the master and theme", () => {
  const deck = parsePptx(
    deckBytes({
      1: slideXml(
        shape('type="title"', paragraph("Binary heaps")) +
          shape(
            'idx="1"',
            paragraph("Complete binary tree") + paragraph("Stored in an array", '<a:pPr lvl="1"/>'),
            { bodyPr: '<a:normAutofit fontScale="50000"/>' }
          )
      ),
    })
  )
  const [slide] = deck.slides
  // Master decoration is drawn behind the slide; master placeholders are not.
  assert.deepEqual(slide.shapes.map(shapeText), [
    "Course logo",
    "Binary heaps",
    "Complete binary tree\nStored in an array",
  ])
  // The master sets a `bg2` background through its colour map.
  assert.equal(slide.background, "#EEEEEE")

  const title = textShape(deck, 1, "Binary heaps")
  assert.deepEqual(rounded(title.box), { x: 0.1, y: 0.1, width: 0.8, height: 0.2 })
  assert.equal(title.paragraphs[0].bullet, undefined)
  // Master title size, and `tx1` mapped to `dk2` by the master's colour map.
  assert.deepEqual(title.paragraphs[0].runs[0], {
    text: "Binary heaps",
    size: 44,
    bold: false,
    italic: false,
    underline: false,
    color: "#223344",
  })

  const body = textShape(deck, 1, "Complete binary tree\nStored in an array")
  assert.deepEqual(rounded(body.box), { x: 0.1, y: 0.4, width: 0.8, height: 0.5 })
  // Bullets and margins per level come from the master body style; the
  // saved shrink-to-fit scale halves every size.
  assert.deepEqual(
    body.paragraphs.map((item) => ({
      level: item.level,
      bullet: item.bullet,
      indent: item.indent,
      size: item.runs[0].size,
    })),
    [
      { level: 0, bullet: "•", indent: 27, size: 14 },
      { level: 1, bullet: "–", indent: 54, size: 12 },
    ]
  )
  deck.dispose()
})

test("a slide can hide the master's decoration and set its own background", () => {
  const deck = parsePptx(
    deckBytes({
      1: slideXml(shape('type="title"', paragraph("Plain slide")), {
        attributes: 'showMasterSp="0"',
        background: '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAFAFA"/></a:solidFill></p:bgPr></p:bg>',
      }),
    })
  )
  assert.deepEqual(deck.slides[0].shapes.map(shapeText), ["Plain slide"])
  assert.equal(deck.slides[0].background, "#FAFAFA")
  deck.dispose()
})

test("numbering counts per level and restarts after an unnumbered paragraph", () => {
  const numbered = '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'
  const deck = parsePptx(
    deckBytes({
      1: slideXml(
        shape(
          undefined,
          paragraph("Insert at the end", numbered) +
            paragraph("Sift up", numbered) +
            paragraph("Compare with the parent", '<a:pPr lvl="1"><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
            paragraph("Swap", numbered) +
            // An empty line takes no number.
            `<a:p>${numbered}</a:p>` +
            paragraph("Done", '<a:pPr algn="ctr"><a:buNone/></a:pPr>') +
            paragraph("Extract the minimum", numbered),
          { spPr: xfrm(0, 0, 4572000, 3429000) }
        )
      ),
    })
  )
  const box = textShape(
    deck,
    1,
    "Insert at the end\nSift up\nCompare with the parent\nSwap\n\nDone\nExtract the minimum"
  )
  assert.deepEqual(
    box.paragraphs.map((item) => [item.bullet, item.align]),
    [
      ["1.", "left"],
      ["2.", "left"],
      ["1.", "left"],
      ["3.", "left"],
      [undefined, "left"],
      [undefined, "center"],
      ["1.", "left"],
    ]
  )
  // A plain text box with no style falls back to 18 pt.
  assert.equal(box.paragraphs[0].runs[0].size, 18)
  deck.dispose()
})

test("run formatting, shaded theme colours and shape styles are applied", () => {
  const deck = parsePptx(
    deckBytes({
      1: slideXml(
        shape(
          undefined,
          `<a:p><a:r><a:rPr sz="1200" b="1" i="1" u="sng"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:rPr><a:t>Shaded</a:t></a:r></a:p>`,
          { spPr: xfrm(0, 0, 914400, 914400) }
        ) +
          // A drawn shape with no fill of its own: accent fill and light text from its style.
          shape(undefined, paragraph("Callout"), {
            spPr: xfrm(914400, 0, 914400, 914400),
            style:
              '<p:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>',
          })
      ),
    })
  )
  assert.deepEqual(textShape(deck, 1, "Shaded").paragraphs[0].runs[0], {
    text: "Shaded",
    size: 12,
    bold: true,
    italic: true,
    underline: true,
    // #4080C0 at half luminance.
    color: "rgb(32 64 96)",
  })
  const callout = textShape(deck, 1, "Callout")
  assert.equal(callout.fill, "#4080C0")
  assert.equal(callout.paragraphs[0].runs[0].color, "#FFFFFF")
  deck.dispose()
})

test("groups, pictures and tables are placed on the slide", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const picture = (id: string, embed: string, description: string) =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="p" descr="${description}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr>${xfrm(0, 3429000, 914400, 685800)}</p:spPr></p:pic>`
  const deck = parsePptx(
    deckBytes(
      {
        1: slideXml(
          // Group children are in a 1-inch child space stretched to 2 inches.
          `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
            `<p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="914400"/></a:xfrm></p:grpSpPr>` +
            shape(undefined, paragraph("In group"), { spPr: xfrm(457200, 0, 457200, 457200) }) +
            `</p:grpSp>` +
            picture("3", "rId2", "Heap diagram") +
            // EMF pictures cannot be drawn and are left out.
            picture("4", "rId3", "Vector chart") +
            `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
            xfrm(4572000, 3429000, 3657600, 1371600, "p") +
            `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>` +
            `<a:tr h="0"><a:tc><a:txBody><a:bodyPr/>${paragraph("Operation")}</a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill></a:tcPr></a:tc>` +
            `<a:tc><a:txBody><a:bodyPr/>${paragraph("Cost")}</a:txBody><a:tcPr/></a:tc></a:tr>` +
            `<a:tr h="0"><a:tc><a:txBody><a:bodyPr/>${paragraph("Insert")}</a:txBody><a:tcPr/></a:tc>` +
            `<a:tc><a:txBody><a:bodyPr/>${paragraph("O(log n)")}</a:txBody><a:tcPr/></a:tc></a:tr>` +
            `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
        ),
      },
      {
        "ppt/slides/_rels/slide1.xml.rels": slideRels(
          ["rId2", "image", "../media/image1.png"],
          ["rId3", "image", "../media/image2.emf"]
        ),
        "ppt/media/image1.png": png,
        "ppt/media/image2.emf": new Uint8Array([1, 2, 3]),
      }
    )
  )
  const shapes = deck.slides[0].shapes

  const grouped = textShape(deck, 1, "In group")
  assert.deepEqual(rounded(grouped.box), {
    x: 0.2,
    y: 0.1333,
    width: 0.1,
    height: 0.1333,
  })

  const images = shapes.filter((item) => item.kind === "image")
  assert.equal(images.length, 1)
  const [image] = images
  assert.ok(image.kind === "image")
  assert.equal(image.alt, "Heap diagram")
  assert.deepEqual(rounded(image.box), { x: 0, y: 0.5, width: 0.1, height: 0.1 })
  const blob = resolveObjectURL(image.src)
  assert.equal(blob?.type, "image/png")
  assert.equal(blob?.size, png.length)

  const table = shapes.find((item) => item.kind === "table")
  assert.ok(table && table.kind === "table")
  assert.deepEqual(rounded(table.box), { x: 0.5, y: 0.5, width: 0.4, height: 0.2 })
  assert.deepEqual(
    table.rows.map((row) => row.map((cell) => [paragraphsText(cell.paragraphs), cell.fill])),
    [
      [
        ["Operation", "#DDEEFF"],
        ["Cost", undefined],
      ],
      [
        ["Insert", undefined],
        ["O(log n)", undefined],
      ],
    ]
  )
  // Table text uses 14 pt and the theme's text colour.
  assert.deepEqual(
    [table.rows[0][0].paragraphs[0].runs[0].size, table.rows[0][0].paragraphs[0].runs[0].color],
    [14, "#223344"]
  )

  // Disposing the deck releases the pictures.
  deck.dispose()
  assert.equal(resolveObjectURL(image.src), undefined)
})

test("files that are too large, not presentations or empty fail with a reader message", () => {
  assert.throws(() => parsePptx(new Uint8Array(MAX_PPTX_BYTES + 1)), /too large to show/)
  assert.throws(() => parsePptx(strToU8("not a zip file")), /could not be read/)
  // The reader shows only these messages, so each one must be a SlideDeckError.
  assert.throws(() => parsePptx(strToU8("not a zip file")), SlideDeckError)
  assert.throws(
    () => parsePptx(zipSync({ "word/document.xml": strToU8("<w:document/>") })),
    /not a PowerPoint presentation/
  )
  assert.throws(
    () => parsePptx(zipSync({ "ppt/presentation.xml": strToU8(PRESENTATION) })),
    /has no slides/
  )
  // Slide XML that inflates past the 80 MB budget is refused before it is unpacked.
  assert.throws(
    () =>
      parsePptx(
        zipSync(
          {
            "ppt/presentation.xml": strToU8(PRESENTATION),
            "ppt/slides/slide1.xml": new Uint8Array(81_000_000),
          },
          { level: 1 }
        )
      ),
    (error) => error instanceof SlideDeckError && /too large to show/.test(error.message)
  )
})
