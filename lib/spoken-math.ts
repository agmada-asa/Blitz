/**
 * Turns TeX formulas from tutor replies into the words a person would say aloud.
 *
 * Read aloud sends plain text to the local speech model, which spells TeX source character by
 * character. This module parses the common TeX subset that lessons use (fractions, roots, powers,
 * subscripts, Greek letters, relations, large operators, and functions) into spoken English. Unknown
 * commands fall back to their names so nothing in a formula is silently dropped.
 */

/** One lexical unit of a TeX formula. */
type MathToken =
  | { kind: "command"; name: string }
  | { kind: "number"; value: string }
  | { kind: "letter"; value: string }
  | { kind: "char"; value: string }

/** Marks a short pause between spoken parts of a formula; collapsed when output is joined. */
const PAUSE = ","

/** Greek letter commands, including variant forms, spoken by their English names. */
const GREEK_LETTERS: Record<string, string> = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  vartheta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  // The speech model reads the bare word "xi" as a Roman numeral.
  xi: "zai",
  omicron: "omicron",
  pi: "pi",
  varpi: "pi",
  rho: "rho",
  varrho: "rho",
  sigma: "sigma",
  varsigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
}

/** Symbol commands spoken as fixed words. Relations include "is" so they read as sentences. */
const SYMBOL_WORDS: Record<string, string> = {
  times: "times",
  cdot: "times",
  ast: "times",
  div: "divided by",
  pm: "plus or minus",
  mp: "minus or plus",
  le: "is less than or equal to",
  leq: "is less than or equal to",
  leqslant: "is less than or equal to",
  ge: "is greater than or equal to",
  geq: "is greater than or equal to",
  geqslant: "is greater than or equal to",
  lt: "is less than",
  gt: "is greater than",
  ll: "is much less than",
  gg: "is much greater than",
  ne: "is not equal to",
  neq: "is not equal to",
  approx: "is approximately",
  simeq: "is approximately",
  cong: "is congruent to",
  equiv: "is equivalent to",
  sim: "is similar to",
  propto: "is proportional to",
  to: "to",
  rightarrow: "to",
  longrightarrow: "to",
  mapsto: "maps to",
  leftarrow: "from",
  Rightarrow: "implies",
  implies: "implies",
  Longrightarrow: "implies",
  Leftarrow: "is implied by",
  iff: "if and only if",
  Leftrightarrow: "if and only if",
  leftrightarrow: "if and only if",
  in: "is in",
  notin: "is not in",
  ni: "contains",
  subset: "is a subset of",
  subseteq: "is a subset of",
  supset: "is a superset of",
  supseteq: "is a superset of",
  cup: "union",
  cap: "intersect",
  setminus: "minus",
  emptyset: "the empty set",
  varnothing: "the empty set",
  forall: "for all",
  exists: "there exists",
  nexists: "there is no",
  neg: "not",
  lnot: "not",
  land: "and",
  wedge: "and",
  lor: "or",
  vee: "or",
  oplus: "x or",
  infty: "infinity",
  partial: "partial",
  nabla: "del",
  angle: "angle",
  triangle: "triangle",
  perp: "is perpendicular to",
  parallel: "is parallel to",
  mid: "given",
  therefore: "therefore",
  because: "because",
  degree: "degrees",
  circ: "composed with",
  prime: "prime",
  ldots: "and so on",
  cdots: "and so on",
  dots: "and so on",
  vdots: "and so on",
  hbar: "h bar",
  ell: "l",
  Re: "the real part of",
  Im: "the imaginary part of",
  bmod: "mod",
  "%": "percent",
  "&": "and",
  $: "dollars",
  "#": "number",
  "{": "",
  "}": "",
  "|": "",
}

/** Named functions spoken as words rather than spelled letter by letter. */
const FUNCTION_WORDS: Record<string, string> = {
  sin: "sine",
  cos: "cosine",
  tan: "tan",
  sec: "sec",
  csc: "cosec",
  cot: "cot",
  arcsin: "arc sine",
  arccos: "arc cosine",
  arctan: "arc tan",
  sinh: "hyperbolic sine",
  cosh: "hyperbolic cosine",
  tanh: "hyperbolic tan",
  log: "log",
  lg: "log",
  ln: "natural log",
  exp: "exponential",
  det: "determinant",
  dim: "dimension",
  ker: "kernel",
  deg: "degree",
  gcd: "G C D",
  max: "max",
  min: "min",
  sup: "supremum",
  inf: "infimum",
  arg: "argument",
  Pr: "probability",
}

/** Large operators whose limits read as "from … to … of". */
const LARGE_OPERATORS: Record<string, string> = {
  sum: "the sum",
  prod: "the product",
  int: "the integral",
  iint: "the double integral",
  iiint: "the triple integral",
  oint: "the contour integral",
  bigcup: "the union",
  bigcap: "the intersection",
  lim: "the limit",
  limsup: "the limit superior",
  liminf: "the limit inferior",
}

/** Accent commands spoken after their base, as in "x hat". */
const ACCENT_WORDS: Record<string, string> = {
  hat: "hat",
  widehat: "hat",
  bar: "bar",
  overline: "bar",
  tilde: "tilde",
  widetilde: "tilde",
  dot: "dot",
  ddot: "double dot",
}

/** Font, sizing, and spacing commands that change appearance but are never spoken. */
const SILENT_COMMANDS = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "middle",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "limits",
  "nolimits",
  "quad",
  "qquad",
  "label",
  "nonumber",
  "notag",
  ",",
  ";",
  ":",
  "!",
  " ",
  "lbrace",
  "rbrace",
  "langle",
  "rangle",
  "lvert",
  "rvert",
  "lVert",
  "rVert",
  "vert",
  "Vert",
])

/** Commands whose single argument is spoken unchanged, ignoring the style they apply. */
const STYLE_COMMANDS = new Set([
  "mathbf",
  "mathit",
  "mathrm",
  "mathsf",
  "mathtt",
  "mathbb",
  "mathcal",
  "mathfrak",
  "mathscr",
  "boldsymbol",
  "bm",
  "pmb",
  "underline",
  "underbrace",
  "overbrace",
  "cancel",
  "boxed",
  "phantom",
])

/** Commands whose argument is ordinary text that should be read as words. */
const TEXT_COMMANDS = new Set([
  "text",
  "textrm",
  "textit",
  "textbf",
  "mbox",
  "operatorname",
])

/** Single letters whose spoken name the speech model would otherwise misread. */
const LETTER_WORDS: Record<string, string> = {
  // A lone "a" is read as the unstressed article rather than the letter name.
  a: "eh",
  A: "eh",
}

/** Letters that commonly name a function, so a following bracket reads as "of". */
const FUNCTION_LETTERS = new Set(["f", "g", "h", "F", "G", "P", "O"])

/** Unicode maths characters that can appear inside formulas, spoken as words. */
const SYMBOL_WORDS_BY_CHARACTER: Record<string, string> = {
  "≤": "is less than or equal to",
  "≥": "is greater than or equal to",
  "≠": "is not equal to",
  "≈": "is approximately",
  "±": "plus or minus",
  "→": "to",
  "⇒": "implies",
  "⇔": "if and only if",
  "∈": "is in",
  "∞": "infinity",
  "√": "the square root of",
  "°": "degrees",
  "∑": "the sum of",
  "∫": "the integral of",
  "∂": "partial",
  "∆": "delta",
  "∴": "therefore",
}

/**
 * Splits TeX source into commands, numbers, single letters, and other characters.
 * @param source Formula source without its surrounding delimiters.
 * @returns Tokens in source order with whitespace removed.
 */
function tokenize(source: string): MathToken[] {
  const tokens: MathToken[] = []
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const command = /^\\([A-Za-z]+|[^A-Za-z])/.exec(rest)
    if (command) {
      tokens.push({ kind: "command", name: command[1] })
      index += command[0].length
      continue
    }
    const number = /^\d+(?:\.\d+)?|^\.\d+/.exec(rest)
    if (number) {
      tokens.push({ kind: "number", value: number[0] })
      index += number[0].length
      continue
    }
    const character = String.fromCodePoint(rest.codePointAt(0)!)
    index += character.length
    if (/\s/.test(character)) continue
    tokens.push(
      /\p{L}/u.test(character)
        ? { kind: "letter", value: character }
        : { kind: "char", value: character }
    )
  }
  return tokens
}

/**
 * Reports whether a spoken part needs a pause to show where it ends, such as "x plus 1" as a base.
 * @param words Spoken words for one part of a formula.
 * @returns True when the part contains more than one word.
 */
function isCompound(words: readonly string[]): boolean {
  return words.filter((word) => word !== PAUSE).length > 1
}

/**
 * Reports whether a spoken word ends an operand, so a following bracket means multiplication.
 * @param word The last word spoken before a bracket.
 * @returns True for numbers, single letters, Greek letters, and powers.
 */
function isOperand(word: string): boolean {
  return (
    /^(?:\p{L}|\d+(?:\.\d+)?|eh|squared|cubed)$/u.test(word) ||
    Object.values(GREEK_LETTERS).includes(word)
  )
}

/**
 * Speaks an exponent the way a teacher would, using "squared" and "cubed" for the common cases.
 * @param exponent Spoken words of the exponent.
 * @returns Words that follow the base, ending in a pause when the exponent is compound.
 */
function powerWords(exponent: readonly string[]): string[] {
  const spoken = exponent.filter((word) => word !== PAUSE).join(" ")
  if (spoken === "2") return ["squared"]
  if (spoken === "3") return ["cubed"]
  if (spoken === "composed with" || spoken === "degrees") return ["degrees"]
  if (spoken === "prime") return ["prime"]
  return [
    "to the power of",
    ...exponent,
    ...(isCompound(exponent) ? [PAUSE] : []),
  ]
}

/** Recursive descent reader over one formula's tokens. */
class MathReader {
  private index = 0
  private readonly tokens: MathToken[]

  /** Stores the token stream to read; unbraced number arguments may split tokens in place. */
  constructor(tokens: MathToken[]) {
    this.tokens = tokens
  }

  /** Returns the next token without consuming it. */
  private peek(): MathToken | undefined {
    return this.tokens[this.index]
  }

  /** Reports whether the next token is a given plain character. */
  private nextIs(character: string): boolean {
    const token = this.peek()
    return token?.kind === "char" && token.value === character
  }

  /**
   * Reads tokens until a closing character at the current nesting level, or the end of input.
   * @param close Character that ends this sequence, which is consumed when found.
   * @returns Spoken words for the sequence.
   */
  readSequence(close?: string): string[] {
    const words: string[] = []
    while (this.index < this.tokens.length) {
      if (close && this.nextIs(close)) {
        this.index += 1
        break
      }
      words.push(...this.readTerm(words, close))
    }
    return words
  }

  /**
   * Reads a braced group or a single atom, as TeX does for command arguments.
   * @returns Spoken words for the argument.
   */
  private readArgument(): string[] {
    if (this.nextIs("{")) {
      this.index += 1
      return this.readSequence("}")
    }
    // An unbraced argument is one token, so `x^23` raises x to 2, then reads 3.
    const token = this.tokens[this.index++]
    if (!token) return []
    if (token.kind === "number" && token.value.length > 1) {
      this.tokens.splice(this.index, 0, {
        kind: "number",
        value: token.value.slice(1),
      })
      return [token.value[0]]
    }
    return this.readAtom(token, [])
  }

  /**
   * Reads the raw text of a braced argument, for commands such as \text whose content is prose.
   * @returns The argument text with nested braces removed.
   */
  private readRawArgument(): string {
    if (!this.nextIs("{")) {
      const token = this.tokens[this.index++]
      if (!token) return ""
      return token.kind === "command" ? token.name : token.value
    }
    this.index += 1
    let depth = 1
    let text = ""
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++]
      if (token.kind === "char" && token.value === "{") depth += 1
      if (token.kind === "char" && token.value === "}") depth -= 1
      if (!depth) break
      if (token.kind === "char" && /[{}]/.test(token.value)) continue
      text +=
        token.kind === "command"
          ? token.name === " "
            ? " "
            : ` ${token.name} `
          : token.value
    }
    return text
  }

  /**
   * Reads an optional bracketed argument, as in \sqrt[3]{x}.
   * @returns Spoken words of the option, or undefined when none is present.
   */
  private readOptional(): string[] | undefined {
    if (!this.nextIs("[")) return undefined
    this.index += 1
    return this.readSequence("]")
  }

  /**
   * Reads one atom and any powers or subscripts attached to it.
   * @param previous Words already spoken in the enclosing sequence, used to detect function calls.
   * @param close Character that ends the enclosing sequence, which must not be consumed here.
   * @returns Spoken words for the term.
   */
  private readTerm(previous: readonly string[], close?: string): string[] {
    const token = this.tokens[this.index++]
    const base =
      token.kind === "command"
        ? this.readCommand(token.name)
        : this.readAtom(token, previous, close)
    return this.readScripts(base)
  }

  /**
   * Attaches subscripts and powers that follow a base.
   * @param base Spoken words of the base.
   * @returns The base followed by its spoken scripts.
   */
  private readScripts(base: string[]): string[] {
    const words = [...base]
    while (this.nextIs("^") || this.nextIs("_") || this.nextIs("'")) {
      const script = this.tokens[this.index++]
      if (script.kind !== "char") break
      if (script.value === "'") {
        words.push("prime")
        continue
      }
      const argument = this.readArgument()
      if (script.value === "_") {
        // Numbered variables read as "x 1"; other indices read as "x sub i".
        if (/^\d+$/.test(argument.join(" "))) words.push(...argument)
        else
          words.push(
            "sub",
            ...argument,
            ...(isCompound(argument) ? [PAUSE] : [])
          )
        continue
      }
      // A compound base needs "all" so "x plus 1, all squared" is not heard as "1 squared".
      if (isCompound(base)) words.push(PAUSE, "all")
      words.push(...powerWords(argument))
    }
    return words
  }

  /**
   * Speaks a letter, number, or plain character.
   * @param token The token to speak.
   * @param previous Words already spoken in the enclosing sequence.
   * @param close Character that ends the enclosing sequence.
   * @returns Spoken words for the atom.
   */
  private readAtom(
    token: MathToken,
    previous: readonly string[],
    close?: string
  ): string[] {
    if (token.kind === "number") return [token.value]
    if (token.kind === "letter")
      return [LETTER_WORDS[token.value] ?? token.value]
    if (token.kind === "command") return this.readCommand(token.name)
    switch (token.value) {
      case "{":
        return this.readSequence("}")
      case "(":
      case "[": {
        const before = this.tokens[this.index - 2]
        const inner = this.readSequence(token.value === "(" ? ")" : "]")
        const last = previous.at(-1)
        // f(x) reads as "f of x"; other brackets only group, so they add a pause when compound.
        if (last && FUNCTION_LETTERS.has(last) && token.value === "(")
          return ["of", ...inner, ...(isCompound(inner) ? [PAUSE] : [])]
        // n(n+1) and (x+1)(x-1) are products, so they read "n times n plus 1".
        const product =
          (last !== undefined && isOperand(last)) ||
          (before?.kind === "char" && before.value === ")")
        const end = isCompound(inner) && !this.nextIs("^") ? [PAUSE] : []
        return product && isCompound(inner)
          ? ["times", ...inner, ...end]
          : [...inner, ...end]
      }
      case "|": {
        // Without a closing bar in this group, a bar reads as "given", as in P(A|B).
        const end = this.tokens.findIndex(
          (candidate, index) =>
            index >= this.index &&
            candidate.kind === "char" &&
            (candidate.value === "|" || candidate.value === close)
        )
        const closing = end >= 0 ? this.tokens[end] : undefined
        if (closing?.kind !== "char" || closing.value !== "|") return ["given"]
        const inner = this.readSequence("|")
        return ["the absolute value of", ...inner, PAUSE]
      }
      case "=":
        return ["equals"]
      case "+":
        return ["plus"]
      case "-":
      case "−":
        return ["minus"]
      case "*":
      case "×":
      case "·":
        return ["times"]
      case "/":
      case "÷":
        return ["over"]
      case "<":
        return ["is less than"]
      case ">":
        return ["is greater than"]
      case "!":
        return ["factorial"]
      case "'":
        return ["prime"]
      case "%":
        return ["percent"]
      case ",":
      case ";":
      case "&":
        return [PAUSE]
      default:
        return /[\p{L}\p{N}]/u.test(token.value)
          ? [token.value]
          : SYMBOL_WORDS_BY_CHARACTER[token.value]
            ? [SYMBOL_WORDS_BY_CHARACTER[token.value]]
            : []
    }
  }

  /**
   * Speaks one TeX command, consuming any arguments it takes.
   * @param name Command name without the backslash.
   * @returns Spoken words for the command.
   */
  private readCommand(name: string): string[] {
    if (SILENT_COMMANDS.has(name)) return []
    if (name === "\\") return [PAUSE]
    if (GREEK_LETTERS[name]) return [GREEK_LETTERS[name]]
    const lower = name.toLowerCase()
    if (/^[A-Z]/.test(name) && GREEK_LETTERS[lower])
      return [GREEK_LETTERS[lower]]
    if (name === "frac" || name === "dfrac" || name === "tfrac")
      return this.readFraction()
    if (name === "sqrt") {
      const index = this.readOptional()
      const radicand = this.readArgument()
      const order = index?.join(" ")
      const root =
        !order || order === "2"
          ? "the square root of"
          : order === "3"
            ? "the cube root of"
            : /^\d+$/.test(order)
              ? `the ${order}th root of`
              : `the root of order ${order} of`
      return [root, ...radicand, ...(isCompound(radicand) ? [PAUSE] : [])]
    }
    if (name === "binom" || name === "dbinom" || name === "tbinom") {
      const top = this.readArgument()
      const bottom = this.readArgument()
      return [...top, "choose", ...bottom, PAUSE]
    }
    if (name === "vec" || name === "overrightarrow")
      return ["vector", ...this.readArgument()]
    if (ACCENT_WORDS[name]) return [...this.readArgument(), ACCENT_WORDS[name]]
    if (STYLE_COMMANDS.has(name)) return this.readArgument()
    if (TEXT_COMMANDS.has(name)) {
      const text = this.readRawArgument().trim()
      return text ? [text] : []
    }
    if (name === "begin" || name === "end") {
      this.readRawArgument()
      return [PAUSE]
    }
    if (name === "pmod") return ["mod", ...this.readArgument()]
    if (LARGE_OPERATORS[name]) return this.readLargeOperator(name)
    if (FUNCTION_WORDS[name]) return this.readFunction(name)
    if (name in SYMBOL_WORDS)
      return SYMBOL_WORDS[name] ? [SYMBOL_WORDS[name]] : []
    // Unknown commands are rare; their name is the clearest fallback.
    return /^[A-Za-z]+$/.test(name) ? [name] : []
  }

  /**
   * Speaks \frac, using "d y by d x" for derivatives and "all over" for compound numerators.
   * @returns Spoken words for the fraction.
   */
  private readFraction(): string[] {
    const numerator = this.readArgument()
    const denominator = this.readArgument()
    const derivative =
      /^(d|partial)\b/.test(numerator.join(" ")) &&
      /^(d|partial)\b/.test(denominator.join(" "))
    if (derivative) return [...numerator, "by", ...denominator, PAUSE]
    return [
      ...numerator,
      ...(isCompound(numerator) ? [PAUSE, "all"] : []),
      "over",
      ...denominator,
      ...(isCompound(denominator) ? [PAUSE] : []),
    ]
  }

  /**
   * Speaks a sum, product, integral, or limit with its limits, as in "the sum from i equals 1 to n of".
   * @param name Operator command name.
   * @returns Spoken words for the operator and its limits.
   */
  private readLargeOperator(name: string): string[] {
    let lower: string[] | undefined
    let upper: string[] | undefined
    while (this.nextIs("_") || this.nextIs("^")) {
      const script = this.tokens[this.index++]
      const argument = this.readArgument()
      if (script.kind === "char" && script.value === "_") lower = argument
      else upper = argument
    }
    const words = [LARGE_OPERATORS[name]]
    if (name.startsWith("lim")) {
      if (lower)
        words.push(
          "as",
          ...lower.map((word) => (word === "to" ? "tends to" : word))
        )
    } else {
      if (lower) words.push("from", ...lower)
      if (upper) words.push("to", ...upper)
    }
    words.push("of")
    return words
  }

  /**
   * Speaks a named function such as \sin or \log, including powers and a logarithm base.
   * @param name Function command name.
   * @returns Spoken words for the function name.
   */
  private readFunction(name: string): string[] {
    const words = [FUNCTION_WORDS[name]]
    while (this.nextIs("_") || this.nextIs("^")) {
      const script = this.tokens[this.index++]
      const argument = this.readArgument()
      if (script.kind === "char" && script.value === "_")
        words.push("base", ...argument, "of")
      // sin^2 x reads "sine squared x", as it is said in class.
      else words.push(...powerWords(argument).filter((word) => word !== PAUSE))
    }
    return words
  }
}

/**
 * Converts a TeX formula into spoken English.
 * @param source Formula source without `$`, `$$`, `\(`, or `\[` delimiters.
 * @returns Spoken words with commas marking pauses; empty when the formula has nothing to say.
 */
export function spokenMath(source: string): string {
  const words = new MathReader(tokenize(source)).readSequence()
  return words
    .filter(Boolean)
    .join(" ")
    .replace(/\s+,/g, ",")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .replace(/\s+/g, " ")
}
