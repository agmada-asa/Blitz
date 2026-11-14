/** Checks the graph block's expression language and plotting helpers. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { compileExpression, ExpressionError } from "../lib/graph-expression.ts"
import {
  fitYRange,
  formatPlotNumber,
  niceTicks,
  sampleCurve,
} from "../lib/graph-plot.ts"
import { parseInteractiveBlock, type GraphBlock } from "../lib/interactive-blocks.ts"

/**
 * Evaluates an expression in x.
 * @param source Expression text.
 * @param x Value of x.
 * @param extra Other variables and their values.
 * @returns The result.
 */
function evaluate(source: string, x: number, extra: Record<string, number> = {}): number {
  return compileExpression(source, ["x", ...Object.keys(extra)])({ x, ...extra })
}

/**
 * Parses a graph body that must be valid.
 * @param body Graph JSON.
 * @returns The graph block.
 */
function graph(body: object): GraphBlock {
  const parsed = parseInteractiveBlock("graph", JSON.stringify(body))
  assert.ok(parsed.ok && parsed.block.kind === "graph")
  return parsed.block as GraphBlock
}

test("follows maths precedence for signs and powers", () => {
  assert.equal(evaluate("-x^2", 3), -9)
  assert.equal(evaluate("2^3^2", 0), 512)
  assert.equal(evaluate("2^-1", 0), 0.5)
  assert.equal(evaluate("1 + 2 * 3 - 4 / 2", 0), 5)
  assert.equal(evaluate("(1 + 2) * 3", 0), 9)
  assert.equal(evaluate("x**2", 4), 16)
  assert.equal(evaluate("1.5e2 + .5", 0), 150.5)
})

test("supports constants, functions and declared variables", () => {
  assert.equal(evaluate("x*log2(x)", 8), 24)
  assert.equal(evaluate("log(e)", 0), 1)
  assert.equal(evaluate("max(1, x, 3)", 5), 5)
  assert.ok(Math.abs(evaluate("sin(pi/2)", 0) - 1) < 1e-12)
  assert.equal(evaluate("a*x + b", 2, { a: 3, b: 1 }), 7)
})

test("returns non-finite values where the maths is undefined", () => {
  assert.ok(Number.isNaN(evaluate("sqrt(x)", -1)))
  assert.equal(evaluate("1/x", 0), Infinity)
})

test("rejects anything outside the language", () => {
  for (const source of [
    "2x",
    "x(1)",
    "sin x",
    "foo(x)",
    "y + 1",
    "x; alert(1)",
    "constructor",
    "__proto__",
    "(x",
    "x +",
    "",
    "max(x)",
    "x".repeat(301),
  ])
    assert.throws(() => compileExpression(source, ["x"]), ExpressionError, source)
})

test("splits sampled curves where they are undefined", () => {
  const fn = compileExpression("sqrt(x)", ["x"])
  const segments = sampleCurve(fn, {}, { min: -1, max: 1 }, 4)
  assert.equal(segments.length, 1)
  assert.deepEqual(
    segments[0].map(([x]) => x),
    [0, 0.5, 1]
  )
  const reciprocal = compileExpression("1/x", ["x"])
  assert.equal(sampleCurve(reciprocal, {}, { min: -1, max: 1 }, 4).length, 2)
})

test("fits a y range from zero and keeps asymptotes from flattening the plot", () => {
  const square = graph({ x: { min: 0, max: 10 }, functions: ["x^2"] })
  const squareCurve = sampleCurve(compileExpression("x^2", ["x"]), {}, square.x)
  const range = fitYRange(square, [[...squareCurve]])
  assert.equal(range.min, 0)
  assert.ok(range.max >= 100 && range.max < 110)

  const tangent = graph({ x: { min: -1.5707, max: 1.5707 }, functions: ["tan(x)"] })
  const tanCurve = sampleCurve(compileExpression("tan(x)", ["x"]), {}, tangent.x)
  const tanRange = fitYRange(tangent, [tanCurve])
  assert.ok(tanRange.max < 100, `max ${tanRange.max}`)

  const fixed = graph({ x: { min: 0, max: 1 }, y: { min: -2, max: 2 }, functions: ["x"] })
  assert.deepEqual(fitYRange(fixed, []), { min: -2, max: 2 })
})

test("chooses round tick values inside the range", () => {
  assert.deepEqual(niceTicks({ min: 0, max: 10 }, 5), [0, 2, 4, 6, 8, 10])
  assert.deepEqual(niceTicks({ min: 1, max: 32 }, 4), [10, 20, 30])
  assert.deepEqual(niceTicks({ min: -1, max: 1 }, 4), [-1, -0.5, 0, 0.5, 1])
})

test("formats plot numbers without float noise", () => {
  assert.equal(formatPlotNumber(0.1 + 0.2), "0.3")
  assert.equal(formatPlotNumber(-2.5), "−2.5")
  assert.equal(formatPlotNumber(25_000), "25k")
  assert.equal(formatPlotNumber(3_400_000), "3.4M")
  assert.equal(formatPlotNumber(2e13), "2.0e+13")
  assert.equal(formatPlotNumber(0.00012), "1.2e-4")
  assert.equal(formatPlotNumber(Number.NaN), "undefined")
})
