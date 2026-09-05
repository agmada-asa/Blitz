/** Renders chat Markdown as semantic React elements without injecting generated HTML. */
import { memo, type ReactNode } from "react"
import type { Token, Tokens } from "marked"
import { markdownHref, markdownText, parseMarkdown } from "@/lib/markdown"
import { resolveCitation, type ChatCitation } from "@/lib/citations"
import { Button } from "@/components/ui/button"

/** Optional server-validated source links supported by this Markdown instance. */
type CitationOptions = {
  citations?: readonly ChatCitation[]
  onCitation?: (citation: ChatCitation) => void
}

/** Renders inline formatting and disables unsupported or unsafe links and images. */
function inline(tokens: Token[], options: CitationOptions): ReactNode {
  return tokens.map((token, key) => {
    const children =
      "tokens" in token && token.tokens
        ? inline(token.tokens ?? [], options)
        : markdownText("text" in token ? token.text : token.raw)
    switch (token.type) {
      case "strong":
        return <strong key={key}>{children}</strong>
      case "em":
        return <em key={key}>{children}</em>
      case "del":
        return <del key={key}>{children}</del>
      case "codespan":
        return <code key={key}>{token.text}</code>
      case "br":
        return <br key={key} />
      case "link": {
        const citation = resolveCitation(token.href, options.citations ?? [])
        if (citation && options.onCitation)
          return (
            <Button
              key={key}
              type="button"
              variant="link"
              className="inline h-auto px-1 py-0 align-baseline text-xs font-medium whitespace-normal text-brand underline decoration-brand/40 underline-offset-4"
              aria-label={`Open ${citation.filename}, ${citation.label}`}
              onClick={() => options.onCitation?.(citation)}
            >
              {new Set(options.citations?.map((item) => item.filename)).size > 1
                ? `${citation.filename}, ${citation.label}`
                : citation.label}
            </Button>
          )
        if (token.href.startsWith("citation:"))
          return (
            <span
              key={key}
              className="text-muted-foreground"
              title="This reference could not be verified"
            >
              {children}
            </span>
          )
        const href = markdownHref(token.href)
        return href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span key={key}>{children}</span>
        )
      }
      default:
        return <span key={key}>{children}</span>
    }
  })
}

/** Renders block structure, keeping wide code and tables inside horizontally scrollable regions. */
function blocks(tokens: Token[], options: CitationOptions): ReactNode {
  return tokens.map((token, key) => {
    switch (token.type) {
      case "space":
        return null
      case "heading": {
        const Heading = `h${Math.min(6, token.depth + 1)}` as "h2"
        return (
          <Heading key={key}>{inline(token.tokens ?? [], options)}</Heading>
        )
      }
      case "paragraph":
      case "text":
        return (
          <p key={key}>
            {token.tokens
              ? inline(token.tokens ?? [], options)
              : markdownText(token.text)}
          </p>
        )
      case "code":
        return (
          <pre key={key} tabIndex={0}>
            <code>{token.text}</code>
          </pre>
        )
      case "blockquote":
        return (
          <blockquote key={key}>
            {blocks(token.tokens ?? [], options)}
          </blockquote>
        )
      case "hr":
        return <hr key={key} />
      case "list": {
        const List = token.ordered ? "ol" : "ul"
        return (
          <List
            key={key}
            start={token.ordered ? Number(token.start) : undefined}
          >
            {(token.items as Tokens.ListItem[]).map((item, index) => (
              <li key={index}>
                {item.task ? (
                  <span aria-label={item.checked ? "Completed" : "Incomplete"}>
                    {item.checked ? "☑ " : "☐ "}
                  </span>
                ) : null}
                {blocks(item.tokens, options)}
              </li>
            ))}
          </List>
        )
      }
      case "table":
        return (
          <div
            key={key}
            className="markdown-table"
            tabIndex={0}
            role="region"
            aria-label="Table"
          >
            <table>
              <thead>
                <tr>
                  {token.header.map((cell: Tokens.TableCell, i: number) => (
                    <th key={i}>{inline(cell.tokens, options)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: Tokens.TableCell[], i: number) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{inline(cell.tokens, options)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      default:
        return <p key={key}>{markdownText(token.raw)}</p>
    }
  })
}

/** Displays selectable Markdown and safely reparses unfinished streaming syntax. */
export const Markdown = memo(function Markdown({
  text,
  ...options
}: { text: string } & CitationOptions) {
  return (
    <div className="chat-markdown">{blocks(parseMarkdown(text), options)}</div>
  )
})
