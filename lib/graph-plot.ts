/**
 * Turns a validated ```graph block into plottable geometry: sampled curve segments, a fitted y range,
 * axis ticks, and tick labels.
 *
 * The graph renderer draws whatever this module returns, so the maths stays in plain functions that Node
 * tests can check without a browser. Curves are sampled in data coordinates; the renderer maps them to
 * pixels.
 */
import { compileExpression, type CompiledExpression } from "./graph-expression.ts"
import type { GraphBlock } from "./interactive-blocks.ts"

/** Samples per curve; enough for smooth curves at the widest frame without slowing slider drags. */
export const GRAPH_SAMPLES = 400

/** A point in data coordinates. */
export type PlotPoint = [number, number]

/** A numeric range on one axis. */
export type PlotRange = { min: number; max: number }

/**
 * Compiles each function in a graph once, for repeated sampling while sliders move.
 * @param block Validated graph; its expressions are known to parse.
 * @returns One compiled expression per function, in order.
 */
export function compileGraphFunctions(block: GraphBlock): CompiledExpression[] {
  const variables = ["x", ...block.params.map((param) => param.name)]
  return block.functions.map((fn) => compileExpression(fn.expr, variables))
}

/**
 * Samples a curve across the x range, splitting it wherever it is undefined (for example `sqrt(x)` for
 * x < 0, or `1/x` at 0) so the renderer never joins across a gap.
 * @param fn Compiled expression.
 * @param values Current parameter values by name.
 * @param range The x range to sample.
 * @param samples Number of evenly spaced samples.
 * @returns Runs of consecutive finite points.
 */
export function sampleCurve(
  fn: CompiledExpression,
  values: Record<string, number>,
  range: PlotRange,
  samples = GRAPH_SAMPLES
): PlotPoint[][] {
  const segments: PlotPoint[][] = []
  let current: PlotPoint[] = []
  for (let index = 0; index <= samples; index += 1) {
    const x = range.min + ((range.max - range.min) * index) / samples
    const y = fn({ ...values, x })
    if (Number.isFinite(y)) current.push([x, y])
    else if (current.length) {
      segments.push(current)
      current = []
    }
  }
  if (current.length) segments.push(current)
  return segments
}

/**
 * Picks the value at a fraction through a sorted list.
 * @param sorted Ascending values, at least one.
 * @param fraction Position from 0 to 1.
 * @returns The nearest value at that position.
 */
function quantile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))]
}

/**
 * Chooses the y range: the graph's own limits where given, otherwise one fitted to the curves (at their
 * starting parameter values) and the data. Curves with asymptotes, such as `tan(x)` or `1/x`, would
 * otherwise flatten everything else, so an extreme tail is cut back to the 2nd–98th percentile.
 * @param block Validated graph.
 * @param curves Sampled curve segments at the starting parameter values.
 * @returns A non-empty range with a little padding where it was fitted.
 */
export function fitYRange(block: GraphBlock, curves: PlotPoint[][][]): PlotRange {
  const curveYs = curves.flat(2).map(([, y]) => y)
  const pointYs = block.points.flatMap((series) => series.data.map(([, y]) => y))
  const all = [...curveYs, ...pointYs].sort((a, b) => a - b)
  let min = block.y.min
  let max = block.y.max
  if (min === undefined || max === undefined) {
    let low = all.length ? all[0] : 0
    let high = all.length ? all[all.length - 1] : 1
    if (curveYs.length > 20) {
      const robustLow = quantile(all, 0.02)
      const robustHigh = quantile(all, 0.98)
      const robustSpan = robustHigh - robustLow
      if (robustSpan > 0 && high - low > 10 * robustSpan) {
        low = Math.min(robustLow, ...pointYs)
        high = Math.max(robustHigh, ...pointYs)
      }
    }
    const span = high - low || Math.abs(high) || 1
    // Start at zero when the data sits just above or below it, so sizes read honestly.
    if (low > 0 && low < span * 0.5) low = 0
    if (high < 0 && -high < span * 0.5) high = 0
    const pad = (high - low || span) * 0.06
    min ??= low === 0 ? 0 : low - pad
    max ??= high === 0 ? 0 : high + pad
  }
  if (min >= max) {
    const centre = min
    min = centre - 1
    max = centre + 1
  }
  return { min, max }
}

/**
 * Returns evenly spaced "nice" tick values (steps of 1, 2, 2.5 or 5 times a power of ten) inside a range.
 * @param range Axis range.
 * @param target Roughly how many ticks to aim for.
 * @returns Ascending tick values within the range.
 */
export function niceTicks(range: PlotRange, target = 5): number[] {
  const span = range.max - range.min
  if (!(span > 0) || !Number.isFinite(span)) return [range.min]
  const rough = span / Math.max(1, target)
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ??
    10 * power
  const ticks: number[] = []
  const first = Math.ceil(range.min / step - 1e-9) * step
  for (let value = first; value <= range.max + step * 1e-9; value += step)
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value)
  return ticks
}

/**
 * Formats a large value compactly, for example 25k or 3.4M. Written by hand rather than with
 * `Intl.NumberFormat`, whose suffixes differ between the server's and the browser's locale data.
 * @param value A number of magnitude at least 10,000.
 * @returns Three significant digits with a k, M or B suffix, or scientific notation beyond that.
 */
function compactNumber(value: number): string {
  const magnitude = Math.abs(value)
  for (const [size, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const)
    if (magnitude >= size && magnitude < size * 1000)
      return `${Number((value / size).toPrecision(3))}${suffix}`
  return value.toExponential(1)
}

/**
 * Formats an axis or readout value compactly: no float noise, compact notation for large numbers and
 * scientific notation for tiny ones.
 * @param value Number to format.
 * @returns Display text using a true minus sign.
 */
export function formatPlotNumber(value: number): string {
  if (!Number.isFinite(value)) return "undefined"
  const magnitude = Math.abs(value)
  let text: string
  if (magnitude === 0) text = "0"
  else if (magnitude >= 10_000) text = compactNumber(value)
  else if (magnitude < 0.001) text = value.toExponential(1)
  else text = String(Number(value.toPrecision(4)))
  return text.replace(/^-/, "−")
}
