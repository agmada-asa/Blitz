/**
 * Turns LaTeX formulas into readable plain Unicode text, for screens that
 * cannot typeset maths (the Android app has no KaTeX). `\frac{n(n+1)}{2}`
 * becomes `n(n+1)/2`, `x^2` becomes `x²`, `\le` becomes `≤`, and `\Theta(n
 * \log n)` becomes `Θ(n log n)`. Anything it does not recognise keeps its
 * command name without the backslash, so a formula is always readable even
 * when it is not pretty.
 */

/** Commands that become a single symbol. */
const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ",
  chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ",
  Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", iff: "⇔", implies: "⇒", mapsto: "↦",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨",
  oplus: "⊕", otimes: "⊗", infty: "∞", partial: "∂", nabla: "∇",
  sum: "Σ", prod: "Π", int: "∫",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", langle: "⟨", rangle: "⟩",
  mid: "|", vert: "|", Vert: "‖", lvert: "|", rvert: "|",
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  log: "log", ln: "ln", lg: "lg", exp: "exp", max: "max", min: "min", sin: "sin", cos: "cos",
  tan: "tan", lim: "lim", gcd: "gcd", mod: "mod", bmod: "mod", deg: "deg", det: "det",
  quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ",
  "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "_": "_", "#": "#",
}

/** Blackboard bold letters for `\mathbb`. */
const BLACKBOARD: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ" }

/** Superscript forms of the characters that have one. */
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", m: "ᵐ", x: "ˣ", T: "ᵀ",
}

/** Subscript forms of the characters that have one. */
const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", j: "ⱼ", k: "ₖ",
  m: "ₘ", n: "ₙ", o: "ₒ", r: "ᵣ", t: "ₜ", x: "ₓ",
}

/** Commands whose braced argument is shown as plain text. */
const TEXT_COMMANDS = new Set([
  "text", "textrm", "textbf", "textit", "texttt", "mathrm", "mathit", "mathbf", "mathsf",
  "mathtt", "mathcal", "operatorname", "boldsymbol", "bm", "emph", "mbox", "hbox",
])

/** Commands dropped entirely, keeping what follows. */
const DROPPED = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "displaystyle", "limits", "nolimits"])

/**
 * Reads one argument at `index`: a braced group, a single command, or a
 * single character.
 * @returns The argument's source and the index just after it.
 */
function readArgument(source: string, index: number): { text: string; end: number } {
  while (source[index] === " ") index++
  if (source[index] === "{") {
    let depth = 0
    for (let at = index; at < source.length; at++) {
      if (source[at] === "\\") {
        at++
        continue
      }
      if (source[at] === "{") depth++
      else if (source[at] === "}" && --depth === 0) return { text: source.slice(index + 1, at), end: at + 1 }
    }
    return { text: source.slice(index + 1), end: source.length }
  }
  if (source[index] === "\\") {
    const command = /^\\([A-Za-z]+|.)/.exec(source.slice(index))
    if (command) return { text: command[0], end: index + command[0].length }
  }
  return { text: source[index] ?? "", end: index + 1 }
}

/**
 * Wraps text in brackets when it has an operator outside any brackets, so
 * `\frac{n+1}{2}` reads `(n+1)/2` while `\frac{n(n+1)}{2}` stays `n(n+1)/2`.
 */
function group(text: string): string {
  let depth = 0
  for (const char of text) {
    if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    else if (depth === 0 && /[\s+\-=<>/±·×−]/.test(char)) return `(${text})`
  }
  return text
}

/** Raises or lowers text with Unicode script characters when every character has one. */
function script(text: string, map: Record<string, string>, marker: "^" | "_"): string {
  const chars = [...text]
  if (chars.length && chars.every((char) => map[char])) return chars.map((char) => map[char]).join("")
  return chars.length === 1 ? `${marker}${text}` : `${marker}(${text})`
}

/**
 * Converts one LaTeX formula to plain text.
 * @param latex The formula without its `$` or `\(` delimiters.
 * @returns Readable Unicode text with collapsed spaces.
 */
export function mathToText(latex: string): string {
  let out = ""
  let index = 0
  while (index < latex.length) {
    const char = latex[index]
    if (char === "\\") {
      const match = /^\\([A-Za-z]+|.)/.exec(latex.slice(index))
      if (!match) {
        index++
        continue
      }
      const name = match[1]
      index += match[0].length
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const top = readArgument(latex, index)
        const bottom = readArgument(latex, top.end)
        index = bottom.end
        out += `${group(mathToText(top.text))}/${group(mathToText(bottom.text))}`
      } else if (name === "sqrt") {
        const argument = readArgument(latex, index)
        index = argument.end
        out += `√${group(mathToText(argument.text))}`
      } else if (name === "binom") {
        const top = readArgument(latex, index)
        const bottom = readArgument(latex, top.end)
        index = bottom.end
        out += `C(${mathToText(top.text)}, ${mathToText(bottom.text)})`
      } else if (name === "pmod") {
        const argument = readArgument(latex, index)
        index = argument.end
        out += ` (mod ${mathToText(argument.text)})`
      } else if (name === "mathbb") {
        const argument = readArgument(latex, index)
        index = argument.end
        out += [...argument.text].map((letter) => BLACKBOARD[letter] ?? letter).join("")
      } else if (TEXT_COMMANDS.has(name)) {
        const argument = readArgument(latex, index)
        index = argument.end
        out += TEXT_COMMANDS.has(name) && name.startsWith("text") ? argument.text : mathToText(argument.text)
      } else if (DROPPED.has(name)) {
        // `\left(` keeps its bracket; the command itself adds nothing.
      } else if (name in SYMBOLS) {
        const symbol = SYMBOLS[name]
        // Named operators read as words, so keep a space after them.
        out += /^[a-z]{2,}$/.test(symbol) ? `${symbol} ` : symbol
      } else {
        out += name
      }
    } else if (char === "^" || char === "_") {
      const argument = readArgument(latex, index + 1)
      index = argument.end
      out += script(mathToText(argument.text), char === "^" ? SUPERSCRIPT : SUBSCRIPT, char)
    } else if (char === "{" || char === "}") {
      index++
    } else if (char === "~") {
      out += " "
      index++
    } else {
      out += char
      index++
    }
  }
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([)\]⌋⌉⟩,.;])/g, "$1")
    .replace(/([(\[⌊⌈⟨])\s+/g, "$1")
    .trim()
}

/**
 * Converts the formulas inside a line of prose (`$…$`, `\\(…\\)`) to plain
 * text and leaves the rest alone, for short strings such as quiz options
 * that are shown without Markdown.
 * @param text Prose that may contain inline formulas.
 */
export function inlineMathToText(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_, formula: string) => mathToText(formula))
    .replace(/\$\$(.+?)\$\$/g, (_, formula: string) => mathToText(formula))
    .replace(/\$([^$\n]+?)\$(?!\d)/g, (match, formula: string) =>
      // Prices such as "$5 and $10" stay as written.
      /^\s|\s$/.test(formula) ? match : mathToText(formula)
    )
}
