/**
 * Parses and evaluates the small maths language used by ```graph blocks.
 *
 * Models write curves as plain expressions such as `a*x^2 + 1` or `x*log2(x)`. They must never run as
 * JavaScript, so this module tokenizes and parses them into a tiny syntax tree and evaluates that tree
 * itself. It supports numbers, `+ - * / ^`, unary minus, brackets, the constants `pi` and `e`, a fixed list
 * of maths functions, and named variables the caller declares (always `x`, plus any slider parameters).
 * It has no browser or React dependencies so the server-side block parser and Node tests can use it.
 */

/** A parsed expression node. */
type ExpressionNode =
  | { type: "number"; value: number }
  | { type: "variable"; name: string }
  | { type: "unary"; operand: ExpressionNode }
  | {
      type: "binary"
      operator: "+" | "-" | "*" | "/" | "^"
      left: ExpressionNode
      right: ExpressionNode
    }
  | { type: "call"; name: string; args: ExpressionNode[] }

/** A compiled expression: evaluates with a value for every declared variable. */
export type CompiledExpression = (variables: Record<string, number>) => number

/** Maximum expression length, so a runaway reply cannot create a huge tree. */
export const EXPRESSION_MAX_CHARS = 300

/** Named constants available in every expression. */
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

/**
 * Functions available in expressions with their allowed argument counts. `log` is the natural log, to
 * match maths notation; `log2` and `log10` cover the other common bases.
 */
const FUNCTIONS: Record<
  string,
  { arity: [number, number]; apply: (...args: number[]) => number }
> = {
  sin: { arity: [1, 1], apply: Math.sin },
  cos: { arity: [1, 1], apply: Math.cos },
  tan: { arity: [1, 1], apply: Math.tan },
  asin: { arity: [1, 1], apply: Math.asin },
  acos: { arity: [1, 1], apply: Math.acos },
  atan: { arity: [1, 1], apply: Math.atan },
  sinh: { arity: [1, 1], apply: Math.sinh },
  cosh: { arity: [1, 1], apply: Math.cosh },
  tanh: { arity: [1, 1], apply: Math.tanh },
  exp: { arity: [1, 1], apply: Math.exp },
  ln: { arity: [1, 1], apply: Math.log },
  log: { arity: [1, 1], apply: Math.log },
  log2: { arity: [1, 1], apply: Math.log2 },
  log10: { arity: [1, 1], apply: Math.log10 },
  sqrt: { arity: [1, 1], apply: Math.sqrt },
  abs: { arity: [1, 1], apply: Math.abs },
  floor: { arity: [1, 1], apply: Math.floor },
  ceil: { arity: [1, 1], apply: Math.ceil },
  round: { arity: [1, 1], apply: Math.round },
  sign: { arity: [1, 1], apply: Math.sign },
  min: { arity: [2, 8], apply: Math.min },
  max: { arity: [2, 8], apply: Math.max },
  pow: { arity: [2, 2], apply: Math.pow },
}

/** Names an expression may not use as variables because they mean something else. */
export const RESERVED_EXPRESSION_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(CONSTANTS),
  ...Object.keys(FUNCTIONS),
])

/** Error thrown for an expression that cannot be parsed or uses an unknown name. */
export class ExpressionError extends Error {}

/** One lexical token. */
type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "symbol"; value: string }

/**
 * Splits an expression into tokens.
 * @param source Expression text.
 * @returns Tokens in order.
 * @throws ExpressionError on a character outside the language.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const pattern =
    /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),]))/y
  let index = 0
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break
    pattern.lastIndex = index
    const match = pattern.exec(source)
    if (!match)
      throw new ExpressionError(
        `unexpected "${source.slice(index).trim()[0]}" in "${source}"`
      )
    if (match[1] !== undefined)
      tokens.push({ kind: "number", value: Number(match[1]) })
    else if (match[2] !== undefined)
      tokens.push({ kind: "name", value: match[2] })
    // `**` is accepted as a synonym for `^` because models often write it.
    else tokens.push({ kind: "symbol", value: match[3] === "**" ? "^" : match[3] })
    index = pattern.lastIndex
  }
  return tokens
}

/**
 * Recursive-descent parser. Precedence, lowest first: `+ -`, `* /`, unary minus, `^` (right
 * associative), so `-x^2` is `-(x^2)` and `2^3^2` is `2^9`, as in maths.
 */
class Parser {
  private position = 0
  private readonly tokens: Token[]
  private readonly variables: ReadonlySet<string>
  private readonly source: string

  /**
   * @param tokens Tokens from `tokenize`.
   * @param variables Names the expression may reference.
   * @param source Original text, for error messages.
   */
  constructor(tokens: Token[], variables: ReadonlySet<string>, source: string) {
    this.tokens = tokens
    this.variables = variables
    this.source = source
  }

  /**
   * Parses the whole token list.
   * @returns The syntax tree.
   * @throws ExpressionError when tokens remain or the expression is incomplete.
   */
  parse(): ExpressionNode {
    if (!this.tokens.length) throw new ExpressionError("expression is empty")
    const node = this.sum()
    if (this.position < this.tokens.length)
      throw new ExpressionError(
        `unexpected "${String(this.tokens[this.position].value)}" in "${this.source}"; write multiplication with *`
      )
    return node
  }

  /** Returns the current token if it is the given symbol, consuming it. */
  private take(symbol: string): boolean {
    const token = this.tokens[this.position]
    if (token?.kind === "symbol" && token.value === symbol) {
      this.position += 1
      return true
    }
    return false
  }

  /** Parses `term (('+' | '-') term)*`. */
  private sum(): ExpressionNode {
    let node = this.product()
    for (;;) {
      if (this.take("+"))
        node = { type: "binary", operator: "+", left: node, right: this.product() }
      else if (this.take("-"))
        node = { type: "binary", operator: "-", left: node, right: this.product() }
      else return node
    }
  }

  /** Parses `unary (('*' | '/') unary)*`. */
  private product(): ExpressionNode {
    let node = this.unary()
    for (;;) {
      if (this.take("*"))
        node = { type: "binary", operator: "*", left: node, right: this.unary() }
      else if (this.take("/"))
        node = { type: "binary", operator: "/", left: node, right: this.unary() }
      else return node
    }
  }

  /** Parses leading signs, which bind more loosely than `^`. */
  private unary(): ExpressionNode {
    if (this.take("-")) return { type: "unary", operand: this.unary() }
    if (this.take("+")) return this.unary()
    return this.power()
  }

  /** Parses `primary ('^' unary)?`, right associative. */
  private power(): ExpressionNode {
    const base = this.primary()
    if (this.take("^"))
      return { type: "binary", operator: "^", left: base, right: this.unary() }
    return base
  }

  /** Parses a number, name, function call, or bracketed expression. */
  private primary(): ExpressionNode {
    const token = this.tokens[this.position]
    if (!token) throw new ExpressionError(`"${this.source}" ends too early`)
    this.position += 1
    if (token.kind === "number") return { type: "number", value: token.value }
    if (token.kind === "symbol") {
      if (token.value !== "(")
        throw new ExpressionError(`unexpected "${token.value}" in "${this.source}"`)
      const inner = this.sum()
      if (!this.take(")"))
        throw new ExpressionError(`missing ")" in "${this.source}"`)
      return inner
    }
    const name = token.value
    if (this.take("(")) {
      const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined
      if (!fn) throw new ExpressionError(`unknown function "${name}"`)
      const args: ExpressionNode[] = []
      if (!this.take(")")) {
        do args.push(this.sum())
        while (this.take(","))
        if (!this.take(")"))
          throw new ExpressionError(`missing ")" after ${name}(…)`)
      }
      if (args.length < fn.arity[0] || args.length > fn.arity[1])
        throw new ExpressionError(
          `${name} takes ${fn.arity[0] === fn.arity[1] ? fn.arity[0] : `${fn.arity[0]} to ${fn.arity[1]}`} argument(s)`
        )
      return { type: "call", name, args }
    }
    // Own-property checks, so names such as "constructor" never reach Object.prototype.
    if (Object.hasOwn(CONSTANTS, name))
      return { type: "number", value: CONSTANTS[name] }
    if (this.variables.has(name)) return { type: "variable", name }
    if (Object.hasOwn(FUNCTIONS, name))
      throw new ExpressionError(`${name} needs brackets, for example ${name}(x)`)
    throw new ExpressionError(`unknown name "${name}" in "${this.source}"`)
  }
}

/**
 * Evaluates a syntax tree.
 * @param node Tree to evaluate.
 * @param variables Value for every variable the tree references.
 * @returns The result; NaN or ±Infinity where the maths is undefined (for example `log(-1)`, `1/0`).
 */
function evaluate(
  node: ExpressionNode,
  variables: Record<string, number>
): number {
  switch (node.type) {
    case "number":
      return node.value
    case "variable":
      return variables[node.name] ?? Number.NaN
    case "unary":
      return -evaluate(node.operand, variables)
    case "call":
      return FUNCTIONS[node.name].apply(
        ...node.args.map((arg) => evaluate(arg, variables))
      )
    case "binary": {
      const left = evaluate(node.left, variables)
      const right = evaluate(node.right, variables)
      switch (node.operator) {
        case "+":
          return left + right
        case "-":
          return left - right
        case "*":
          return left * right
        case "/":
          return left / right
        case "^":
          return Math.pow(left, right)
      }
    }
  }
}

/**
 * Parses an expression once so it can be evaluated many times while sampling a curve.
 * @param source Expression text, at most `EXPRESSION_MAX_CHARS` characters.
 * @param variables Names the expression may use besides the built-in constants and functions.
 * @returns A function that evaluates the expression for given variable values.
 * @throws ExpressionError when the text is too long, malformed, or uses an unknown name.
 */
export function compileExpression(
  source: string,
  variables: Iterable<string>
): CompiledExpression {
  if (source.length > EXPRESSION_MAX_CHARS)
    throw new ExpressionError(
      `expression must be at most ${EXPRESSION_MAX_CHARS} characters`
    )
  const tree = new Parser(tokenize(source), new Set(variables), source).parse()
  return (values) => evaluate(tree, values)
}
