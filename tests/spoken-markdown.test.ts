/** Verifies read aloud text keeps block boundaries and speaks formulas, currency, and symbols as words. */

import assert from "node:assert/strict"
import test from "node:test"
import { spokenMarkdownText, spokenProse } from "../lib/spoken-markdown.ts"
import { spokenMath } from "../lib/spoken-math.ts"

test("ends headings, list items, and table rows as separate sentences", () => {
  assert.equal(
    spokenMarkdownText(
      "## Photosynthesis\nPlants make food\n\n- First point\n- Second point: details\n\n| Item | Price |\n| --- | --- |\n| Tea | £1.20 |"
    ),
    "Photosynthesis.\nPlants make food.\nFirst point.\nSecond point: details.\nItem, Price.\nTea, 1 pound 20."
  )
})

test("keeps a lesson title apart from the first paragraph", () => {
  assert.equal(
    spokenMarkdownText("Key idea\n\nCells divide."),
    "Key idea.\nCells divide."
  )
})

test("skips code, images, and interactive blocks", () => {
  assert.equal(
    spokenMarkdownText(
      'Read this.\n\n```quiz\n{"question":"Hidden"}\n```\n\n![Diagram](https://example.com/a.png)\n\n```ts\nconst x = 1\n```'
    ),
    "Read this."
  )
})

test("speaks currency amounts in spoken order", () => {
  assert.equal(
    spokenProse("£1, £2.50, £0.40, £1.5m, $20bn, €3, -£3, 50p, £5–£10"),
    "1 pound, 2 pounds 50, 40 pence, 1.5 million pounds, 20 billion dollars, 3 euros, minus 3 pounds, 50 pence, 5 pounds to 10 pounds"
  )
  assert.equal(
    spokenMarkdownText("It costs $5 and $10 total."),
    "It costs 5 dollars and 10 dollars total."
  )
})

test("speaks prose notation without changing dates", () => {
  assert.equal(
    spokenProse("x^2, x^23, mc², 3/4, 25°C, A → B, e.g. water, 10/10/2026"),
    "x squared, x to the power of 23, mc squared, 3 over 4, 25 degrees Celsius, A to B, for example water, 10/10/2026"
  )
})

test("speaks inline and display formulas instead of their source", () => {
  assert.equal(
    spokenMarkdownText(
      "Solve $x^2 + 3x - 4 = 0$ with\n\n$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$"
    ),
    "Solve x squared plus 3 x minus 4 equals 0 with.\nx equals minus b plus or minus the square root of b squared minus 4 eh c, all over 2 eh."
  )
})

test("reads common formula structures the way they are said", () => {
  const cases: [string, string][] = [
    ["\\frac{dy}{dx} = 2x", "d y by d x, equals 2 x"],
    ["\\frac{1}{3}", "1 over 3"],
    ["\\int_0^1 x^2\\,dx", "the integral from 0 to 1 of x squared d x"],
    [
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "the sum from i equals 1 to n of i equals n times n plus 1, all over 2",
    ],
    [
      "\\lim_{x \\to 0} \\frac{\\sin x}{x}",
      "the limit as x tends to 0 of sine x, all over x",
    ],
    ["P(A|B)", "P of eh given B"],
    [
      "|x - 1| < \\epsilon",
      "the absolute value of x minus 1, is less than epsilon",
    ],
    ["a_n = a_{n-1} + d", "eh sub n equals eh sub n minus 1, plus d"],
    ["x_1", "x 1"],
    ["(x+1)^2", "x plus 1, all squared"],
    ["(x+1)(x-1)", "x plus 1, times x minus 1"],
    ["e^{i\\pi}", "e to the power of i pi"],
    ["x^{-1}", "x to the power of minus 1"],
    ["x^23", "x squared 3"],
    ["\\sqrt[3]{8}", "the cube root of 8"],
    ["\\sin^2\\theta", "sine squared theta"],
    ["\\log_2 8", "log base 2 of 8"],
    ["\\vec{v} \\cdot \\hat{u}", "vector v times u hat"],
    ["\\theta \\in [0, 2\\pi]", "theta is in 0, 2 pi"],
    [
      "\\text{speed} = \\frac{\\text{distance}}{\\text{time}}",
      "speed equals distance over time",
    ],
    ["\\binom{n}{k}", "n choose k"],
    ["\\unknown{x}", "unknown x"],
  ]
  for (const [source, spoken] of cases)
    assert.equal(spokenMath(source), spoken, source)
})

test("tolerates incomplete formulas without throwing", () => {
  for (const source of [
    "\\frac{1}",
    "x^",
    "{",
    "\\sqrt",
    "|x",
    "\\begin{matrix} 1 & 2 \\\\ 3 & 4",
  ])
    assert.equal(typeof spokenMath(source), "string")
})
