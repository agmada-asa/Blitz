"use client"

/**
 * Renders a ```graph block: functions and data drawn natively as SVG on one pair of axes, with sliders
 * for any parameters and a crosshair readout under the pointer.
 *
 * Unlike ```viz, nothing model-authored runs here: expressions were parsed into a syntax tree by
 * `lib/graph-expression.ts` and are evaluated by it, and the geometry comes from `lib/graph-plot.ts`.
 * Series colours are the `--chart-*` tokens, so graphs follow light and dark themes. The same figure
 * can open larger in a dialog that shares the slider state.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import type { GraphBlock } from "@/lib/interactive-blocks"
import {
  compileGraphFunctions,
  fitYRange,
  formatPlotNumber,
  niceTicks,
  sampleCurve,
  type PlotPoint,
  type PlotRange,
} from "@/lib/graph-plot"
import { Slider } from "@/components/ui/slider"
import { ExpandFigureButton } from "@/components/ui/interactive-blocks/expand-figure"

/** Space around the plot area for tick labels and axis titles, in CSS pixels. */
const MARGIN = { top: 12, right: 16, bottom: 44, left: 56 }
/** Plot heights inline and in the larger dialog. */
const INLINE_HEIGHT = 300
const EXPANDED_HEIGHT = 560
/** How far, in pixels, the pointer may be from a data point for the readout to include it. */
const POINT_HIT_RADIUS = 18

/**
 * Returns the colour for a series by its position, functions first and then point series.
 * @param index Zero-based series index, below the six chart tokens.
 * @returns A CSS colour referencing a theme token.
 */
function seriesColour(index: number): string {
  return `var(--chart-${(index % 6) + 1})`
}

/** Maps data coordinates to pixels for one plot size. */
type Scale = {
  x: (value: number) => number
  y: (value: number) => number
  invertX: (pixel: number) => number
  width: number
  height: number
}

/**
 * Builds the data-to-pixel mapping for a plot.
 * @param xRange Data range across the plot.
 * @param yRange Data range up the plot.
 * @param width Whole SVG width.
 * @param height Whole SVG height.
 * @returns The scale, with the plot area's inner width and height.
 */
function makeScale(
  xRange: PlotRange,
  yRange: PlotRange,
  width: number,
  height: number
): Scale {
  const innerWidth = Math.max(1, width - MARGIN.left - MARGIN.right)
  const innerHeight = Math.max(1, height - MARGIN.top - MARGIN.bottom)
  const xSpan = xRange.max - xRange.min
  const ySpan = yRange.max - yRange.min
  return {
    x: (value) => MARGIN.left + ((value - xRange.min) / xSpan) * innerWidth,
    y: (value) => MARGIN.top + ((yRange.max - value) / ySpan) * innerHeight,
    invertX: (pixel) =>
      xRange.min + ((pixel - MARGIN.left) / innerWidth) * xSpan,
    width: innerWidth,
    height: innerHeight,
  }
}

/**
 * Converts sampled segments to an SVG path. Values far outside the y range are clamped so the path
 * stays a sane size (the plot is clipped anyway), and a jump from far above to far below, as at an
 * asymptote, starts a new subpath instead of drawing a vertical line.
 * @param segments Runs of finite points from `sampleCurve`.
 * @param scale Current scale.
 * @param yRange Current y range.
 * @returns Path data, or an empty string when there is nothing to draw.
 */
function curvePath(
  segments: PlotPoint[][],
  scale: Scale,
  yRange: PlotRange
): string {
  const span = yRange.max - yRange.min
  const low = yRange.min - span * 4
  const high = yRange.max + span * 4
  const commands: string[] = []
  for (const segment of segments) {
    let previous: number | undefined
    segment.forEach(([x, rawY], index) => {
      const y = Math.min(high, Math.max(low, rawY))
      const side = rawY > yRange.max ? 1 : rawY < yRange.min ? -1 : 0
      const jump =
        previous !== undefined && side !== 0 && previous === -side
      commands.push(
        `${index === 0 || jump ? "M" : "L"}${scale.x(x).toFixed(1)},${scale.y(y).toFixed(1)}`
      )
      previous = side
    })
  }
  return commands.join("")
}

/**
 * Tracks an element's content width so the SVG can be drawn at its real size, keeping text crisp.
 * @returns A ref for the element and its current width (0 before the first measurement).
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** One line of the pointer readout. */
type ReadoutRow = { label: string; value: string; colour: string }

/**
 * Draws the axes, grid, curves, points, and pointer readout for a graph.
 * @param block Validated graph.
 * @param curves Sampled segments per function at the current slider values.
 * @param evaluate Evaluates function `index` at an x value with the current slider values.
 * @param yRange Fixed y range for this graph.
 * @param height SVG height in pixels.
 * @returns The plot, sized to its container's width.
 */
function GraphPlot({
  block,
  curves,
  evaluate,
  yRange,
  height,
}: {
  block: GraphBlock
  curves: PlotPoint[][][]
  evaluate: (index: number, x: number) => number
  yRange: PlotRange
  height: number
}) {
  const clipId = `graph-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hoverX, setHoverX] = useState<number>()
  const xRange = block.x
  const scale = width ? makeScale(xRange, yRange, width, height) : undefined
  const xTicks = niceTicks(xRange, width && width < 420 ? 4 : 7)
  const yTicks = niceTicks(yRange, height > 400 ? 8 : 5)
  const seriesLabels = [...block.functions, ...block.points].map(
    (series) => series.label
  )
  const description = `${block.title ? `${block.title}: ` : ""}${seriesLabels.join(", ")}, for ${block.x.label ?? "x"} from ${formatPlotNumber(xRange.min)} to ${formatPlotNumber(xRange.max)}.`

  /** Follows the pointer across the plot area, clearing the readout outside it. */
  function trackPointer(event: PointerEvent<SVGSVGElement>) {
    if (!scale) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const pixel = event.clientX - bounds.left
    if (pixel < MARGIN.left || pixel > MARGIN.left + scale.width)
      setHoverX(undefined)
    else setHoverX(scale.invertX(pixel))
  }

  // The readout lists each curve's value at the pointer and the nearest data point of each series.
  const readout: ReadoutRow[] = []
  const markers: Array<{ x: number; y: number; colour: string }> = []
  if (scale && hoverX !== undefined) {
    block.functions.forEach((fn, index) => {
      const y = evaluate(index, hoverX)
      readout.push({
        label: fn.label,
        value: formatPlotNumber(y),
        colour: seriesColour(index),
      })
      if (Number.isFinite(y) && y >= yRange.min && y <= yRange.max)
        markers.push({ x: hoverX, y, colour: seriesColour(index) })
    })
    block.points.forEach((series, seriesIndex) => {
      const colour = seriesColour(block.functions.length + seriesIndex)
      let nearest: PlotPoint | undefined
      let distance = POINT_HIT_RADIUS
      for (const point of series.data) {
        const gap = Math.abs(scale.x(point[0]) - scale.x(hoverX))
        if (gap <= distance) {
          nearest = point
          distance = gap
        }
      }
      if (nearest)
        readout.push({
          label: series.label,
          value: `(${formatPlotNumber(nearest[0])}, ${formatPlotNumber(nearest[1])})`,
          colour,
        })
    })
  }
  const readoutOnLeft =
    scale && hoverX !== undefined && scale.x(hoverX) > MARGIN.left + scale.width / 2

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {scale ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={description}
          className="block touch-pan-y select-none"
          onPointerMove={trackPointer}
          onPointerDown={trackPointer}
          onPointerLeave={() => setHoverX(undefined)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={MARGIN.left}
                y={MARGIN.top}
                width={scale.width}
                height={scale.height}
              />
            </clipPath>
          </defs>
          {/* Recessive grid with tick labels in muted ink. */}
          <g aria-hidden="true" fontSize={12} fill="var(--muted-foreground)">
            {yTicks.map((tick) => (
              <g key={`y${tick}`}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + scale.width}
                  y1={scale.y(tick)}
                  y2={scale.y(tick)}
                  stroke="var(--border)"
                  strokeWidth={tick === 0 ? 1.5 : 1}
                />
                <text
                  x={MARGIN.left - 8}
                  y={scale.y(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {formatPlotNumber(tick)}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <g key={`x${tick}`}>
                <line
                  x1={scale.x(tick)}
                  x2={scale.x(tick)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + scale.height}
                  stroke="var(--border)"
                  strokeWidth={tick === 0 ? 1.5 : 1}
                />
                <text
                  x={scale.x(tick)}
                  y={MARGIN.top + scale.height + 18}
                  textAnchor="middle"
                >
                  {formatPlotNumber(tick)}
                </text>
              </g>
            ))}
            {block.x.label ? (
              <text
                x={MARGIN.left + scale.width / 2}
                y={height - 6}
                textAnchor="middle"
                fill="var(--foreground)"
              >
                {block.x.label}
              </text>
            ) : null}
            {block.y.label ? (
              <text
                transform={`translate(14 ${MARGIN.top + scale.height / 2}) rotate(-90)`}
                textAnchor="middle"
                fill="var(--foreground)"
              >
                {block.y.label}
              </text>
            ) : null}
          </g>
          <g clipPath={`url(#${clipId})`} aria-hidden="true">
            {curves.map((segments, index) => (
              <path
                key={`f${index}`}
                d={curvePath(segments, scale, yRange)}
                fill="none"
                stroke={seriesColour(index)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={block.functions[index].dashed ? "6 5" : undefined}
              />
            ))}
            {block.points.map((series, seriesIndex) => {
              const colour = seriesColour(block.functions.length + seriesIndex)
              return (
                <g key={`p${seriesIndex}`}>
                  {series.line ? (
                    <path
                      d={series.data
                        .map(
                          ([x, y], index) =>
                            `${index ? "L" : "M"}${scale.x(x).toFixed(1)},${scale.y(y).toFixed(1)}`
                        )
                        .join("")}
                      fill="none"
                      stroke={colour}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  ) : null}
                  {series.data.map(([x, y], index) => (
                    <circle
                      key={index}
                      cx={scale.x(x)}
                      cy={scale.y(y)}
                      r={4}
                      fill={colour}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  ))}
                </g>
              )
            })}
            {hoverX !== undefined ? (
              <line
                x1={scale.x(hoverX)}
                x2={scale.x(hoverX)}
                y1={MARGIN.top}
                y2={MARGIN.top + scale.height}
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
              />
            ) : null}
            {markers.map((marker, index) => (
              <circle
                key={index}
                cx={scale.x(marker.x)}
                cy={scale.y(marker.y)}
                r={5}
                fill={marker.colour}
                stroke="var(--background)"
                strokeWidth={2}
              />
            ))}
          </g>
        </svg>
      ) : null}
      {scale && hoverX !== undefined ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-3 max-w-[60%] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
          style={
            readoutOnLeft
              ? { right: width - scale.x(hoverX) + 12 }
              : { left: scale.x(hoverX) + 12 }
          }
        >
          <p className="mb-1 font-medium">
            {block.x.label ?? "x"} = {formatPlotNumber(hoverX)}
          </p>
          {readout.map((row) => (
            <p key={row.label} className="flex items-center gap-2">
              <span
                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: row.colour }}
              />
              <span className="truncate">{row.label}</span>
              <span className="ml-auto pl-2 tabular-nums">{row.value}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Lists each series with its colour; colour alone never identifies a series.
 * @param block Validated graph.
 * @returns The legend, or null for a single series under a title that already names it.
 */
function GraphLegend({ block }: { block: GraphBlock }) {
  const series = [
    ...block.functions.map((fn) => ({ label: fn.label, dashed: fn.dashed, dot: false })),
    ...block.points.map((points) => ({ label: points.label, dashed: false, dot: !points.line })),
  ]
  if (series.length === 1 && block.title) return null
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
      {series.map((entry, index) => (
        <li key={index} className="flex items-center gap-2">
          <svg width={18} height={10} aria-hidden="true" className="shrink-0">
            {entry.dot ? (
              <circle cx={9} cy={5} r={4} fill={seriesColour(index)} />
            ) : (
              <line
                x1={1}
                x2={17}
                y1={5}
                y2={5}
                stroke={seriesColour(index)}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={entry.dashed ? "4 3" : undefined}
              />
            )}
          </svg>
          {entry.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * Renders one slider per parameter with its current value.
 * @param block Validated graph.
 * @param values Current values by parameter name.
 * @param onChange Called with a parameter name and its new value.
 * @returns The controls, or null when the graph has no parameters.
 */
function GraphControls({
  block,
  values,
  onChange,
}: {
  block: GraphBlock
  values: Record<string, number>
  onChange: (name: string, value: number) => void
}) {
  if (!block.params.length) return null
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {block.params.map((param) => (
        <label key={param.name} className="grid gap-2 text-sm">
          <span className="flex items-baseline justify-between gap-3">
            <span>{param.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatPlotNumber(values[param.name])}
            </span>
          </span>
          <Slider
            min={param.min}
            max={param.max}
            step={param.step}
            value={[values[param.name]]}
            onValueChange={([value]) => onChange(param.name, value)}
            aria-label={param.label}
          />
        </label>
      ))}
    </div>
  )
}

/**
 * Renders a validated graph block with its title, an "Open larger" view, legend, sliders, and source.
 * @param block Validated graph.
 * @param children Source view, normally the highlighted JSON code block.
 * @returns The graph figure.
 */
export function GraphBlockView({
  block,
  children,
}: {
  block: GraphBlock
  children: ReactNode
}) {
  const startValues = useMemo(
    () =>
      Object.fromEntries(block.params.map((param) => [param.name, param.value])),
    [block]
  )
  const [changed, setChanged] = useState<{
    block: GraphBlock
    values: Record<string, number>
  }>()
  // Slider positions belong to one block; a new block (for example a re-rendered reply) starts fresh.
  const values = changed?.block === block ? changed.values : startValues
  const compiled = useMemo(() => compileGraphFunctions(block), [block])
  // The y range is fitted once at the starting values so the axes stay still while sliders move.
  const yRange = useMemo(
    () =>
      fitYRange(
        block,
        compiled.map((fn) => sampleCurve(fn, startValues, block.x))
      ),
    [block, compiled, startValues]
  )
  const curves = useMemo(
    () => compiled.map((fn) => sampleCurve(fn, values, block.x)),
    [compiled, values, block.x]
  )

  /** Evaluates one function at x with the current slider values. */
  function evaluate(index: number, x: number): number {
    return compiled[index]({ ...values, x })
  }

  /** Stores a slider's new value. */
  function setValue(name: string, value: number) {
    setChanged({ block, values: { ...values, [name]: value } })
  }

  const title = block.title ?? "Graph"
  /** The plot with its legend and sliders, at a given height. */
  const body = (height: number) => (
    <div className="space-y-3">
      <GraphPlot
        block={block}
        curves={curves}
        evaluate={evaluate}
        yRange={yRange}
        height={height}
      />
      <GraphLegend block={block} />
      <GraphControls block={block} values={values} onChange={setValue} />
    </div>
  )

  return (
    <figure className="interactive-block min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        {block.title ? (
          <figcaption className="font-medium">{block.title}</figcaption>
        ) : (
          <span />
        )}
        <ExpandFigureButton title={title}>{body(EXPANDED_HEIGHT)}</ExpandFigureButton>
      </div>
      {body(INLINE_HEIGHT)}
      <details className="markdown-diagram-source">
        <summary>View source</summary>
        {children}
      </details>
    </figure>
  )
}
