/** Checks the LaTeX to plain text conversion used where maths cannot be typeset. */
import assert from "node:assert/strict"
import { test } from "node:test"

import { inlineMathToText, mathToText } from "../lib/math-text.ts"

test("fractions, powers, and subscripts read naturally", () => {
  assert.equal(mathToText("T(n) = \\frac{n(n+1)}{2}"), "T(n) = n(n+1)/2")
  assert.equal(mathToText("x^2 + y^{10}"), "x² + y¹⁰")
  assert.equal(mathToText("a_{i+1} = 2a_i"), "aᵢ₊₁ = 2aᵢ")
  assert.equal(mathToText("2^{\\log n}"), "2^(log n)")
  assert.equal(mathToText("\\frac{1}{2}"), "1/2")
  assert.equal(mathToText("\\sqrt{n}"), "√n")
  assert.equal(mathToText("\\frac{n+1}{2}"), "(n+1)/2")
})

test("operators, Greek letters, and named functions become symbols and words", () => {
  assert.equal(mathToText("\\Theta(n \\log n)"), "Θ(n log n)")
  assert.equal(mathToText("a \\le b \\neq c"), "a ≤ b ≠ c")
  assert.equal(mathToText("\\forall x \\in \\mathbb{N}"), "∀ x ∈ ℕ")
  assert.equal(mathToText("\\left\\lfloor \\frac{n}{2} \\right\\rfloor"), "⌊n/2⌋")
  assert.equal(mathToText("p \\cdot q \\times r"), "p · q × r")
})

test("text commands keep their words and unknown commands stay readable", () => {
  assert.equal(mathToText("\\text{if } n > 0"), "if n > 0")
  assert.equal(mathToText("\\operatorname{cost}(n)"), "cost(n)")
  assert.equal(mathToText("\\weird x"), "weird x")
})

test("inline formulas in prose are converted and prices are left alone", () => {
  assert.equal(inlineMathToText("$H(n)=2+H(n-1)$"), "H(n)=2+H(n-1)")
  assert.equal(inlineMathToText("Costs $\\Theta(n^2)$ steps"), "Costs Θ(n²) steps")
  assert.equal(inlineMathToText("From \\(n \\le 3\\) on"), "From n ≤ 3 on")
  assert.equal(inlineMathToText("It costs $5 and $10"), "It costs $5 and $10")
})
