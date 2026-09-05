/** Renders chat Markdown as semantic React elements without injecting generated HTML. */
import { memo, type ReactNode } from "react"
import type { Token, Tokens } from "marked"
import { markdownHref, markdownText, parseMarkdown } from "@/lib/markdown"

/** Renders inline formatting and disables unsupported or unsafe links and images. */
function inline(tokens: Token[]): ReactNode {
  return tokens.map((token, key) => {
    const children =
      "tokens" in token && token.tokens
        ? inline(token.tokens ?? [])
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
function blocks(tokens: Token[]): ReactNode {
  return tokens.map((token, key) => {
    switch (token.type) {
      case "space":
        return null
      case "heading": {
        const Heading = `h${Math.min(6, token.depth + 1)}` as "h2"
        return <Heading key={key}>{inline(token.tokens ?? [])}</Heading>
      }
      case "paragraph":
      case "text":
        return (
          <p key={key}>
            {token.tokens
              ? inline(token.tokens ?? [])
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
        return <blockquote key={key}>{blocks(token.tokens ?? [])}</blockquote>
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
                {blocks(item.tokens)}
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
                    <th key={i}>{inline(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: Tokens.TableCell[], i: number) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{inline(cell.tokens)}</td>
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
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">{blocks(parseMarkdown(text))}</div>
})
