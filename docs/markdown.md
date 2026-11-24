# Markdown display

Web and desktop chat replies, reasoning traces, source previews, and study
explanations share `components/ui/markdown.tsx`, built on the Marked parser
and the helpers in `lib/markdown.ts`. The renderer supports GitHub flavored
Markdown, tables, task lists, images, syntax highlighting, and the following
generated formats:

- Inline LaTeX with `$…$` or `\(...\)`.
- Display LaTeX with `$$…$$` or `\[…\]`.
- Display formulas in `math`, `latex`, `tex`, or `katex` code fences.
- Diagrams in `mermaid` code fences, including flowcharts, sequences, and other
  diagram types supported by the installed Mermaid version.
- GitHub callouts using blockquotes beginning with `[!NOTE]`, `[!TIP]`,
  `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`.
- Interactive blocks (quiz, steps, viz, graph, followups) in their own fences;
  see [interactive blocks](interactive-blocks.md). Each also has a source view.

`lib/markdown.ts` recognizes formula tokens before Markdown can consume LaTeX
backslashes or interpret subscripts as emphasis. Formula parsing is opt-in for
the web renderer; speech parsing keeps its own rules. Code spans and ordinary
code fences preserve their source. Single-dollar math requires non-space
characters next to both delimiters, and a closing `$` followed by a digit is
not a delimiter, so `$5 and $10` stays text. A single-dollar span that looks
like code also stays text: one containing a double quote, or starting with a
word of three or more letters followed directly by a quote, `:`, `,` or a
closing bracket. So MongoDB operators such as
`{"$group": {"_id": "$brand"}}` or `{$sum: 1}` in quiz text aren't read as
formulas. Escape literal dollars as `\$` when currency and formulas share a
paragraph.

Only explicit HTTP, HTTPS and mailto links open. Images load only from HTTP(S)
URLs without credentials, lazily and with no referrer. Tables and code scroll
horizontally inside the reply. Unfinished fences render sensibly while a reply
streams, and new text follows the reader only while they stay near the bottom.

KaTeX (`components/ui/markdown-math.tsx`) renders formulas locally with accessible MathML and bundled fonts. It
blocks trusted HTML and URL commands, limits formula size and macro expansion,
and isolates macro state per formula. Invalid or unsupported formulas display
their source instead of breaking the reply. This supports KaTeX's math syntax,
not arbitrary LaTeX document packages.

Mermaid (`components/ui/markdown-mermaid.tsx`) loads only when a diagram is
displayed. Diagrams are drawn in the app's own palette and font rather than a
stock Mermaid theme, redraw when the theme or accent changes, and can be
opened larger. Rendering is serialized because Mermaid's configuration is
global, and diagram source is capped at 50,000 characters. Security settings are locked;
generated SVG is sanitized again before insertion. Embedded HTML, external SVG
images, links, and click handlers are disabled. Diagrams keep their natural text
size and scroll horizontally in narrow replies. Each diagram has a source view
and copy action; invalid diagrams show source directly. Cancelled or superseded
renders cannot replace newer streamed content. Rendering sends no source text
to an external service.

Raw HTML in Markdown remains literal text. Copying or exporting a full reply
preserves its original Markdown and formula delimiters. No generation or
persistence format changes are required for existing saved replies.

Run `node --test --experimental-strip-types tests/markdown.test.ts` for delimiter,
code, currency, nested formatting, and streamed-prefix regressions. Browser
verification should also cover valid and invalid Mermaid, equation overflow,
keyboard focus, theme changes, and copying exact diagram source.
