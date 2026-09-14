"use client"

/** Renders chat Markdown as semantic React elements without injecting generated HTML. */
import { memo, type ReactNode } from "react"
import type { Token, Tokens } from "marked"
import { QuoteUpIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  markdownHref,
  markdownImageSrc,
  markdownText,
  parseMarkdown,
} from "@/lib/markdown"
import { resolveCitation, type ChatCitation } from "@/lib/citations"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** User annotation shape resolved by Markdown hyperlinks. */
export type ChatAnnotation = {
  id: string
  number?: number
  messageId: string
  selectedText: string
  note: string
  createdAt?: number
}

/** Optional server-validated source links and annotations supported by this Markdown instance. */
type CitationOptions = {
  citations?: readonly ChatCitation[]
  onCitation?: (citation: ChatCitation) => void
  annotations?: readonly ChatAnnotation[]
}

/** Renders a model hyperlink referencing a user annotation, opening a read-only text display bubble. */
function AnnotationLink({
  annotation,
  children,
}: {
  annotation: ChatAnnotation
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-xs font-medium text-brand bg-brand/10 hover:bg-brand/20 underline decoration-brand/40 underline-offset-2 transition-colors cursor-pointer"
          aria-label={`Annotation ${annotation.number ?? ""}: ${annotation.note.slice(0, 40)}`}
        >
          <HugeiconsIcon icon={QuoteUpIcon} size={12} className="shrink-0" />
          <span>{children}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-72 sm:w-80 rounded-xl border border-border bg-card p-3 shadow-lg text-xs"
      >
        <div className="flex items-center justify-between pb-1.5 border-b border-border/60">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <span className="flex size-4.5 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-brand-foreground">
              {annotation.number ?? 1}
            </span>
            <span>Annotation {annotation.number ?? ""}</span>
          </div>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Read only
          </span>
        </div>
        {annotation.selectedText ? (
          <blockquote className="mt-2.5 max-h-24 overflow-y-auto rounded bg-muted/40 p-2 text-muted-foreground italic border-l-2 border-brand/60 text-[11px] leading-relaxed">
            &ldquo;{annotation.selectedText}&rdquo;
          </blockquote>
        ) : null}
        <div className="mt-2 text-foreground leading-relaxed whitespace-pre-wrap">
          {annotation.note}
        </div>
      </PopoverContent>
    </Popover>
  )
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
      case "image": {
        const src = markdownImageSrc(token.href)
        return src ? (
          <img
            key={key}
            src={src}
            alt={markdownText(token.text)}
            title={token.title ? markdownText(token.title) : undefined}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="max-w-full rounded-md"
          />
        ) : (
          <span key={key}>{children}</span>
        )
      }
      case "link": {
        const annotationMatch = /^annotation:(.+)$/.exec(token.href)
        if (annotationMatch) {
          const keyOrId = annotationMatch[1]
          const annotation = options.annotations?.find(
            (item) =>
              item.id === keyOrId ||
              (item.number !== undefined && String(item.number) === keyOrId)
          )
          if (annotation) {
            return (
              <AnnotationLink key={key} annotation={annotation}>
                {children}
              </AnnotationLink>
            )
          }
          return (
            <span
              key={key}
              className="text-muted-foreground"
              title="This annotation could not be found"
            >
              {children}
            </span>
          )
        }
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
