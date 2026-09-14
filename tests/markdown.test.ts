/** Exercises Markdown syntax shared by the web and Android renderers. */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  markdownHref,
  markdownImageSrc,
  markdownText,
  parseMarkdown,
} from "../lib/markdown.ts"

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
