# Source import flow

`components/learn/add-material.tsx` adds files, pasted notes, and public HTTP(S) links to a module, filed under a new or existing unit. Every entry method uploads through `POST /api/sources/upload`, so each source gets the same extraction, passages, and citations; pasted notes and links are uploaded as Markdown text files. Files upload one at a time, so an unreadable file produces a recoverable row while later files continue. A source is ready to teach as soon as extraction finishes; see `docs/teach.md`.

The Sources page reads persisted source status and ingestion jobs, so progress and retry survive a page reload.

Public links go through `/api/sources/fetch`. The server uses the pinned public URL transport, limits the response, and permits PDF, HTML, Markdown, plain text, and PowerPoint responses. PDF bytes return to the browser and reuse the existing PDF extractor. HTML is parsed with the browser's native `DOMParser`; the first `main`, `article`, or `[role="main"]` region is preferred and navigation, scripts, styles, and sidebars are removed. The extracted page text is then uploaded as a Markdown source.

Imported links retain both a filename derived from the URL path and the validated original URL in the source record. PowerPoint extraction uses the installed `fflate` ZIP decoder, reads only `ppt/slides/slideN.xml`, emits explicit `[Slide N]` markers, and rejects archives above 20 MB compressed, 50 MB declared uncompressed, or 5 MB per entry. It stores the result as schema-compatible `text` with the original `.pptx` filename.
