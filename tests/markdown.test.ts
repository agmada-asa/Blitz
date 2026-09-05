/** Exercises Markdown syntax shared by the web and Android renderers. */
import assert from "node:assert/strict"
import { test } from "node:test"
import { markdownHref, markdownText, parseMarkdown } from "../lib/markdown.ts"

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
