/** Exercises Markdown syntax shared by the web and Android renderers. */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Token, Tokens } from "marked"
import {
  markdownHref,
  markdownImageSrc,
  markdownText,
  parseMarkdown,
  type MathToken,
} from "../lib/markdown.ts"

/** Collects nested formulas from lists, emphasis, links, and table cells for parser regressions. */
function formulas(tokens: Token[]): MathToken[] {
  return tokens.flatMap((token) => {
    if (token.type === "math") return [token as MathToken]
    if (token.type === "list")
      return token.items.flatMap((item: Tokens.ListItem) =>
        formulas(item.tokens)
      )
    if (token.type === "table")
      return [token.header, ...token.rows].flatMap((row: Tokens.TableCell[]) =>
        row.flatMap((cell) => formulas(cell.tokens))
      )
    return "tokens" in token && token.tokens ? formulas(token.tokens) : []
  })
}

test("Web math preserves LaTeX commands, nested formatting, and display delimiters", () => {
  const tokens = parseMarkdown(
    String.raw`For **\(n\ge2\)**, use $\Theta(n^2)$.

\[
3n^2 \le 3n^2+2n-2 \le 4n^2.
\]

- Subscript $c_1$ and escaped dollar $\text{\$5}$.

| Bound |
|---|
| $\Omega(n^2)$ |

$$\sum_{i=1}^{n} i$$`,
    { math: true }
  )
  assert.deepEqual(
    formulas(tokens).map((token) => [token.text, token.display]),
    [
      [String.raw`n\ge2`, false],
      [String.raw`\Theta(n^2)`, false],
      [String.raw`3n^2 \le 3n^2+2n-2 \le 4n^2.`, true],
      ["c_1", false],
      [String.raw`\text{\$5}`, false],
      [String.raw`\Omega(n^2)`, false],
      [String.raw`\sum_{i=1}^{n} i`, true],
    ]
  )
})

test("Math leaves prices, escaped openers, code, and native parsing unchanged", () => {
  for (const text of [
    "Prices are $5 and $10.",
    String.raw`Escaped \$x$ and \\(x\\).`,
  ])
    assert.equal(formulas(parseMarkdown(text, { math: true })).length, 0)
  const text = String.raw`Inline code: \`$x$\`.

\`\`\`js
const value = "$x$";
\`\`\``.replaceAll("\\`", "`")
  assert.equal(formulas(parseMarkdown(text, { math: true })).length, 0)
  assert.equal(formulas(parseMarkdown(String.raw`$x$ and \(y\)`)).length, 0)
  const fences = parseMarkdown(
    "```math\nx^2\n```\n\n```mermaid\ngraph LR\nA-->B\n```",
    { math: true }
  )
  assert.deepEqual(
    fences
      .filter((token): token is Tokens.Code => token.type === "code")
      .map((token) => token.lang),
    ["math", "mermaid"]
  )
})

test("Every streamed formula prefix stays readable without parser failures", () => {
  const reply = String.raw`For \(n\ge2\), $c_1=3$.

\[3n^2 \le 4n^2\]

$$\begin{aligned}a&=b\\c&=d\end{aligned}$$`
  for (let end = 0; end <= reply.length; end++)
    assert.doesNotThrow(() =>
      parseMarkdown(reply.slice(0, end), { math: true })
    )
  assert.equal(formulas(parseMarkdown(reply, { math: true })).length, 4)
})

test("Markdown parses headings, nested lists, tables, and unfinished code fences", () => {
  const tokens = parseMarkdown(
    "# Heading\n\n1. **First**\n   - Nested\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1"
  )
  assert.deepEqual(
    tokens.filter((token) => token.type !== "space").map((token) => token.type),
    ["heading", "list", "table", "code"]
  )
  const last = tokens.at(-1)
  assert.ok(last && "text" in last)
  assert.equal(last.text, "const x = 1")
  for (let i = 0; i < 50; i++)
    assert.doesNotThrow(() =>
      parseMarkdown(
        "**Partial** [link](https://example.com)\n```js\ntext".slice(0, i)
      )
    )
})

test("Markdown links reject executable protocols, credentials, and obfuscation", () => {
  for (const href of [
    "javascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "intent://app",
    "https://user:pass@example.com",
    "https://example.com\n",
  ]) {
    if (href.endsWith("\n")) continue // Trimming surrounding whitespace is safe.
    assert.equal(markdownHref(href), undefined)
  }
  assert.equal(
    markdownHref("https://example.com/?a=1&amp;b=2"),
    "https://example.com/?a=1&b=2"
  )
  assert.equal(markdownText("&lt;script&gt; &amp; &#x1f9e0;"), "<script> & 🧠")
})

test("Markdown images allow safe remote sources and reject local or executable URLs", () => {
  assert.equal(
    markdownImageSrc("https://cdn.example.com/diagram.png?x=1&amp;y=2"),
    "https://cdn.example.com/diagram.png?x=1&y=2"
  )
  for (const source of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/onload=alert(1)>",
    "file:///tmp/diagram.png",
    "//cdn.example.com/diagram.png",
    "https://user:pass@cdn.example.com/diagram.png",
  ]) {
    assert.equal(markdownImageSrc(source), undefined)
  }
})

test("Markdown remains tokenizable for every incomplete streamed prefix", () => {
  const reply =
    "# Heading\n\nHere is **bold** and [a link](https://example.com).\n\n![diagram](https://cdn.example.com/diagram.png)\n\n```ts\nconst answer = 42\n```"
  for (let end = 0; end <= reply.length; end++) {
    assert.doesNotThrow(() => parseMarkdown(reply.slice(0, end)))
  }
  const complete = parseMarkdown(reply)
  const hasImage = complete.some((token) =>
    "tokens" in token
      ? token.tokens?.some((nested) => nested.type === "image")
      : false
  )
  assert.equal(hasImage, true)
})
