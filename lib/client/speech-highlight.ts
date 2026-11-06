/** Highlights currently spoken prose without changing rendered lesson markup. */

/** Finds exact prose across text nodes; unsupported browsers and maths simply keep their normal appearance. */
export function highlightSpeech(text: string): () => void {
  if (typeof CSS === "undefined") return () => {}
  const clear = () => { if ("highlights" in CSS) CSS.highlights.delete("read-aloud") }
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return clear
  clear()
  const needle = text.trim()
  if (!needle) return clear
  const roots = [...document.querySelectorAll("[data-message-id], [role=region]")]
  for (const root of roots.reverse()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("button, .katex, pre, [aria-hidden=true], .sr-only")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes: { node: Node; at: number; end: number }[] = []
    let combined = ""
    while (walker.nextNode()) {
      const node = walker.currentNode
      nodes.push({ node, at: combined.length, end: combined.length + (node.textContent?.length ?? 0) })
      combined += node.textContent
    }
    const at = combined.indexOf(needle)
    if (at < 0) continue
    const first = nodes.find(node => node.end > at)
    const last = nodes.find(node => node.end >= at + needle.length)
    if (!first || !last) continue
    const range = document.createRange()
    range.setStart(first.node, at - first.at)
    range.setEnd(last.node, at + needle.length - last.at)
    CSS.highlights.set("read-aloud", new Highlight(range))
    break
  }
  return clear
}
