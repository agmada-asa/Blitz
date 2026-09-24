# Downloaded source extraction

`extractDownloadedSource` is the server boundary for approved research
downloads. It accepts the bounded bytes and final URL returned by the public
HTTP(S) fetcher and returns a persistence-compatible filename, source kind, and
readable text.

Supported formats are PDF, Markdown, plain text, HTML, and small PPTX files.
PPTX extraction reads only bounded `ppt/slides/slideN.xml` entries with the
installed ZIP runtime, caps each slide XML entry at 1 MB and all slide XML at
20 MB, and returns readable slides with `[Slide N]` markers. Empty slide-only
decks fail as unreadable. PDF extraction
uses the installed `pdfjs-dist` runtime and reads at most 500 pages. Research
downloads use bounded in-memory bytes. Project-local PDFs use file-backed range
reads so a large original does not need an equally large server heap allocation.
PDF parsing disables evaluation when supported, sorts positioned text into lines
and common two- or three-column reading order, and keeps `[Page N]` markers in page order.
Scanned or image-only PDFs fail with an OCR message; this boundary
does not perform OCR.

Research downloads are capped at 5 MB. Original project uploads stream to the
local project folder without an application byte limit. Extracted text is capped
at 2,000,000 characters by the parser and 500 KB at the current Convex
persistence boundary. Local PPTX parsing keeps a separate 20 MB compressed-file
limit because its ZIP parser operates in memory. A parsing or text bound leaves
the original saved for an agent to inspect with its available tools.
Empty downloads and empty documents return structured ingestion errors with
actionable messages. HTML extraction selects the first `main` or `article`
region when present, removes scripts and styles, decodes common entities, and
normalizes block boundaries. It is a small server fallback rather than a full
HTML parser, so callers should use a vetted parser dependency if exact web page
fidelity becomes necessary.

The helper does not fetch URLs, execute downloaded markup, follow links, or run
OCR. The research import flow should call it only after the public URL helper
has validated and bounded the download, then persist the returned text and the
original approved URL as provenance. The validated final URL is used only to identify the downloaded format and filename.
