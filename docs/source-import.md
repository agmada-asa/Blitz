# Source import flow

The project source panel accepts multiple PDF, Markdown, text, and small PowerPoint files, pasted notes, and public HTTP(S) links. Selected files are extracted in the browser one at a time, so an unreadable file produces a recoverable row while later files continue. Each readable source is persisted first and then handed to `api.preparation.enqueue`; the browser returns as soon as the queue mutation succeeds.

The project page reads persisted source status and preparation jobs, so progress and retry survive a page reload. The study action opens the home feed filtered to that project.

Public links go through `/api/sources/fetch`. The server uses the pinned public URL transport, limits the response, and permits PDF, HTML, Markdown, plain text, and PowerPoint responses. PDF bytes return to the browser and reuse the existing PDF extractor. HTML is parsed with the browser's native `DOMParser`; the first `main`, `article`, or `[role="main"]` region is preferred and navigation, scripts, styles, and sidebars are removed. The extracted page text is then stored as a regular text source.

Imported links retain both a filename derived from the URL path and the validated original URL in the source record. PowerPoint extraction uses the installed `fflate` ZIP decoder, reads only `ppt/slides/slideN.xml`, emits explicit `[Slide N]` markers, and rejects archives above 20 MB compressed, 50 MB declared uncompressed, or 5 MB per entry. It stores the result as schema-compatible `text` with the original `.pptx` filename.
