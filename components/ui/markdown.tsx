"use client"

/** Renders shared web Markdown with safe links, highlighted code, formulas, diagrams, and interactive blocks. */
import { memo, type ReactNode, useMemo, useState } from "react"
import type { Token, Tokens } from "marked"
import { Copy01Icon, QuoteUpIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import hljs from "highlight.js/lib/core"
import type { LanguageFn } from "highlight.js"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cpp from "highlight.js/lib/languages/cpp"
import css from "highlight.js/lib/languages/css"
import csharp from "highlight.js/lib/languages/csharp"
import go from "highlight.js/lib/languages/go"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import php from "highlight.js/lib/languages/php"
import plaintext from "highlight.js/lib/languages/plaintext"
import python from "highlight.js/lib/languages/python"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import {
  markdownHref,
  markdownImageSrc,
  markdownText,
  parseMarkdown,
} from "@/lib/markdown"
import { resolveCitation, type ChatCitation } from "@/lib/citations"
import {
  isClosedCodeFence,
  isInteractiveBlockLanguage,
  parseInteractiveBlock,
  type InteractiveBlockLanguage,
} from "@/lib/interactive-blocks"
import { Button } from "@/components/ui/button"
import {
  InteractiveBlockPlaceholder,
  InteractiveBlockView,
  useInteractiveBlocks,
  type MarkdownRenderer,
} from "@/components/ui/interactive-blocks"
import { MarkdownMath } from "@/components/ui/markdown-math"
import { MarkdownMermaid } from "@/components/ui/markdown-mermaid"
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

/** Options accepted by `Markdown`. */
type MarkdownOptions = CitationOptions & {
  /**
   * True while the text is still streaming, so unfinished interactive blocks show a placeholder
   * instead of raw code. Defaults to `streaming` from `InteractiveBlocksProvider`, then false.
   */
  streaming?: boolean
}

/** Resolved options threaded through block rendering. */
type RenderOptions = CitationOptions & {
  streaming: boolean
  /** False inside interactive blocks, so nested interactive fences render as plain code. */
  interactive: boolean
}

/** Describes a nested syntax token emitted by the highlighter. */
type HighlightNode = {
  className: string
  children: Array<HighlightNode | string>
}

/** Creates a private Highlight.js instance for explicit and automatic grammar selection. */
const codeHighlighter = hljs.newInstance()

/** Languages highlighted directly and considered during automatic language detection. */
const supportedCodeLanguages: Array<[string, LanguageFn]> = [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["css", css],
  ["csharp", csharp],
  ["go", go],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["php", php],
  ["plaintext", plaintext],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
]

for (const [name, grammar] of supportedCodeLanguages)
  codeHighlighter.registerLanguage(name, grammar)

/**
 * Maps a Markdown fence name to a registered grammar, preserving unknown names for auto-detection.
 * @param language Raw language text from the Markdown fence.
 * @returns The normalized grammar name, or an empty string for an empty fence.
 */
function canonicalCodeLanguage(language: string): string | undefined {
  const name = language
    .trim()
    .split(/[\s,{]/, 1)[0]
    ?.toLowerCase()
  const aliases: Record<string, string> = {
    "c++": "cpp",
    cc: "cpp",
    cxx: "cpp",
    cs: "csharp",
    "c#": "csharp",
    h: "c",
    hpp: "cpp",
    html: "xml",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    plain: "plaintext",
    py: "python",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "typescript",
    text: "plaintext",
    txt: "plaintext",
    yml: "yaml",
  }
  return aliases[name] ?? name
}

/**
 * Parses Highlight.js spans into nested text nodes, decoding escaped source without injecting HTML.
 * @param markup Escaped markup returned by Highlight.js.
 * @returns Nested syntax nodes with source text decoded for React rendering.
 */
function parseHighlightMarkup(markup: string): Array<HighlightNode | string> {
  const root: HighlightNode = { className: "", children: [] }
  const stack = [root]
  const spanTags = /<span class="([^"]+)">|<\/span>/g
  let offset = 0

  for (const match of markup.matchAll(spanTags)) {
    const index = match.index ?? offset
    if (index > offset)
      stack[stack.length - 1].children.push(
        markdownText(markup.slice(offset, index))
      )

    if (match[0] === "</span>") {
      if (stack.length > 1) stack.pop()
    } else {
      const node: HighlightNode = {
        className: match[1],
        children: [],
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    }
    offset = index + match[0].length
  }

  if (offset < markup.length)
    stack[stack.length - 1].children.push(markdownText(markup.slice(offset)))
  return root.children
}

/**
 * Converts parsed tokens to keyed React spans and preserves all source characters as text.
 * @param nodes Parsed syntax nodes from the highlighter.
 * @param parentKey Stable key prefix for nested spans.
 * @returns React spans and text nodes suitable for rendering inside `code`.
 */
function renderHighlightNodes(
  nodes: Array<HighlightNode | string>,
  parentKey = "token"
): ReactNode[] {
  return nodes.map((node, index) => {
    if (typeof node === "string") return node
    return (
      <span key={`${parentKey}-${index}`} className={node.className}>
        {renderHighlightNodes(node.children, `${parentKey}-${index}`)}
      </span>
    )
  })
}

/**
 * Highlights code with a registered grammar or auto-detects an unknown fence.
 * @param code Exact code text to display.
 * @param requestedLanguage Language specified by the Markdown fence, if any.
 * @returns Highlight.js markup and the language label to display above the code.
 */
function highlightCode(code: string, requestedLanguage: string) {
  const canonical = canonicalCodeLanguage(requestedLanguage)
  if (canonical === "mermaid")
    return {
      markup: codeHighlighter.highlight(code, { language: "plaintext" }).value,
      label: "Mermaid",
    }
  const hasGrammar = Boolean(
    canonical && codeHighlighter.getLanguage(canonical)
  )
  const result = hasGrammar
    ? codeHighlighter.highlight(code, {
        language: canonical as string,
        ignoreIllegals: true,
      })
    : codeHighlighter.highlightAuto(code)
  const language =
    result.language ?? (canonical && !hasGrammar ? undefined : canonical)
  const labels: Record<string, string> = {
    bash: "Bash",
    c: "C",
    cpp: "C++",
    css: "CSS",
    csharp: "C#",
    go: "Go",
    java: "Java",
    javascript: "JavaScript",
    json: "JSON",
    markdown: "Markdown",
    php: "PHP",
    plaintext: "Plain text",
    python: "Python",
    ruby: "Ruby",
    rust: "Rust",
    sql: "SQL",
    typescript: "TypeScript",
    xml: "HTML / XML",
    yaml: "YAML",
  }
  const originalLabel =
    canonical && labels[canonical]
      ? labels[canonical]
      : requestedLanguage.trim()

  return {
    markup: result.value,
    label: language
      ? (labels[language] ?? language)
      : originalLabel || "Plain text",
  }
}

/**
 * Renders source code and its language label; Copy writes the exact source to the clipboard.
 * @param code Exact fenced source text.
 * @param language Markdown fence language used for highlighting or automatic detection.
 * @returns A labeled, syntax-colored code block with a copy action.
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const highlighted = useMemo(
    () => highlightCode(code, language),
    [code, language]
  )

  /**
   * Copies the exact source and briefly confirms success, leaving the action unchanged if clipboard access fails.
   * @returns A promise that settles after clipboard access succeeds or fails.
   */
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="markdown-code-block group/code">
      <div className="markdown-code-header">
        <span className="markdown-code-language">{highlighted.label}</span>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="markdown-copy-button"
          onClick={copyCode}
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={18} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0}>
        <code>
          {renderHighlightNodes(parseHighlightMarkup(highlighted.markup))}
        </code>
      </pre>
    </div>
  )
}

/**
 * Renders a copy action that writes a tab-separated Markdown table.
 * @param text Table text with tab-separated cells and newline-separated rows.
 * @returns A button that copies the table and reports successful copying.
 */
function CopyTableButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  /**
   * Copies the supplied table text and briefly confirms success, leaving the action unchanged on clipboard failure.
   * @returns A promise that settles after clipboard access succeeds or fails.
   */
  async function copyTable() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="markdown-table-copy"
      onClick={copyTable}
      aria-label={copied ? "Table copied" : "Copy table"}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
      {copied ? "Copied" : "Copy table"}
    </Button>
  )
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
      case "math":
        return (
          <MarkdownMath
            key={key}
            text={token.text}
            display={token.display}
            inline
          />
        )
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

/**
 * Creates the Markdown renderer used inside interactive blocks. It keeps citation handling but disables
 * interactive blocks, so nested fences render as code and rendering cannot recurse.
 * @param options Options of the Markdown containing the interactive block.
 * @returns A renderer for block Markdown, or a single paragraph's inline content when `inline` is set;
 * inline text that is not a single paragraph is shown as plain text.
 */
function nestedMarkdownRenderer(options: RenderOptions): MarkdownRenderer {
  const nested: RenderOptions = { ...options, interactive: false }
  return function renderNestedMarkdown(
    text,
    { inline: inlineOnly = false } = {}
  ) {
    const tokens = parseMarkdown(text, { math: true })
    if (!inlineOnly)
      return <div className="chat-markdown">{blocks(tokens, nested)}</div>
    const content = tokens.filter((token) => token.type !== "space")
    return content.length === 1 && content[0].type === "paragraph"
      ? inline(content[0].tokens ?? [], nested)
      : markdownText(text)
  }
}

/**
 * Renders an interactive fence, or a placeholder while it is still streaming.
 * @param token Fenced code token whose language is interactive.
 * @param language Interactive block language from the fence.
 * @param key React key for the rendered element.
 * @param options Current render options.
 * @returns The interactive view for a complete valid block, a placeholder while streaming, or undefined
 * when the finished block is invalid so the caller shows the source as code.
 */
function interactiveBlock(
  token: Tokens.Code,
  language: InteractiveBlockLanguage,
  key: number,
  options: RenderOptions
): ReactNode | undefined {
  const parsed = parseInteractiveBlock(token.lang ?? "", token.text)
  // While streaming, an unclosed fence may still be growing even if it already parses.
  const complete = !options.streaming || isClosedCodeFence(token.raw)
  if (parsed.ok && complete)
    return (
      <InteractiveBlockView
        key={key}
        block={parsed.block}
        streaming={options.streaming}
        renderMarkdown={nestedMarkdownRenderer(options)}
        source={<CodeBlock code={token.text} language="html" />}
      />
    )
  if (options.streaming)
    return <InteractiveBlockPlaceholder key={key} language={language} />
  return undefined
}

/** Renders block structure, keeping wide code and tables inside horizontally scrollable regions. */
function blocks(tokens: Token[], options: RenderOptions): ReactNode {
  return tokens.map((token, key) => {
    switch (token.type) {
      case "math":
        return <MarkdownMath key={key} text={token.text} display />
      case "space":
      case "checkbox":
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
      case "code": {
        const language = token.lang?.split(/[\s,]/)[0]?.toLowerCase() ?? ""
        // Teach outline and section markers drive navigation, not reading.
        if (language === "outline" || language === "section") return null
        if (options.interactive && isInteractiveBlockLanguage(language)) {
          const rendered = interactiveBlock(
            token as Tokens.Code,
            language,
            key,
            options
          )
          if (rendered !== undefined) return rendered
        }
        if (["math", "latex", "tex", "katex"].includes(language))
          return <MarkdownMath key={key} text={token.text} display />
        if (language === "mermaid")
          return (
            <MarkdownMermaid key={key} source={token.text}>
              <CodeBlock code={token.text} language="mermaid" />
            </MarkdownMermaid>
          )
        return <CodeBlock key={key} code={token.text} language={language} />
      }
      case "blockquote": {
        const alert =
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\n|$)/i.exec(
            token.text
          )
        if (alert) {
          const label = alert[1].toLowerCase()
          return (
            <aside key={key} className="markdown-alert" aria-label={label}>
              <p className="markdown-alert-title">
                {label[0].toUpperCase() + label.slice(1)}
              </p>
              {blocks(
                parseMarkdown(token.text.slice(alert[0].length), {
                  math: true,
                }),
                options
              )}
            </aside>
          )
        }
        return (
          <blockquote key={key}>
            {blocks(token.tokens ?? [], options)}
          </blockquote>
        )
      }
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
            className="markdown-table group/table"
            tabIndex={0}
            role="region"
            aria-label="Table"
          >
            <CopyTableButton
              text={[
                token.header
                  .map((cell: Tokens.TableCell) => markdownText(cell.text))
                  .join("\t"),
                ...token.rows.map((row: Tokens.TableCell[]) =>
                  row
                    .map((cell: Tokens.TableCell) => markdownText(cell.text))
                    .join("\t")
                ),
              ].join("\n")}
            />
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
  streaming,
  ...options
}: { text: string } & MarkdownOptions) {
  const interactive = useInteractiveBlocks()
  return (
    <div className="chat-markdown">
      {blocks(parseMarkdown(text, { math: true }), {
        ...options,
        streaming: streaming ?? interactive.streaming ?? false,
        interactive: true,
      })}
    </div>
  )
})
