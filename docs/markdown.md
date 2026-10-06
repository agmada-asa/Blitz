# Markdown display

Web and desktop chat replies, reasoning traces, source previews, and study
explanations share `components/ui/markdown.tsx`. The renderer supports GitHub
flavored Markdown, tables, task lists, images, syntax highlighting, and the
following generated formats:

- Inline LaTeX with `$…$` or `\(...\)`.
- Display LaTeX with `$$…$$` or `\[…\]`.
- Display formulas in `math`, `latex`, `tex`, or `katex` code fences.
- Diagrams in `mermaid` code fences, including flowcharts, sequences, and other
  diagram types supported by the installed Mermaid version.
- GitHub callouts using blockquotes beginning with `[!NOTE]`, `[!TIP]`,
  `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`.

`lib/markdown.ts` recognizes formula tokens before Markdown can consume LaTeX
backslashes or interpret subscripts as emphasis. Formula parsing is opt-in for
the web renderer. Native mobile and speech parsing keep their existing behavior.
Code spans and ordinary code fences preserve their source. Single-dollar math
requires non-space characters next to both delimiters. Escape literal dollars
as `\$` when currency and formulas share a paragraph.

KaTeX renders formulas locally with accessible MathML and bundled fonts. It
blocks trusted HTML and URL commands, limits formula size and macro expansion,
and isolates macro state per formula. Invalid or unsupported formulas display
their source instead of breaking the reply. This supports KaTeX's math syntax,
not arbitrary LaTeX document packages.

Mermaid loads only when a diagram is displayed. Rendering is serialized because
its theme configuration is global. Security and theme settings are locked;
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
