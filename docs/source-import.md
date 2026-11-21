# Adding material

`Add material` (`components/learn/add-material.tsx`) adds files, pasted notes and public links to a module, filed under a new or existing unit. Every route in goes through `POST /api/sources/upload`, so each source gets the same extraction, passages and citations. A source is ready to teach once its text is extracted; see [Teach](teach.md).

## Entry points

- **Files** upload one at a time, so a file that fails leaves a row with its error while the rest carry on. The picker accepts PDF, PowerPoint `.pptx`, Word `.docx`, Markdown, plain text, `.vtt` and `.srt` subtitles, HTML, CSV, JSON and common code files.
- **Pasted notes** are saved as a Markdown file named after their first line (up to 60 characters), or `Pasted notes.md`.
- **Links** go through `POST /api/sources/fetch`, which downloads the page with the pinned public URL transport (5 MB, 15 seconds, three redirects; see [source ingestion](source-ingestion.md#public-urls)) and returns the bytes. Word links are refused with 415. The browser then extracts the text with `extractSourceResponse` (`lib/client/extract-source.ts`): PDFs go through the browser PDF reader, PowerPoint decks through a small ZIP reader that emits `[Slide N]` markers, and HTML through the browser's `DOMParser`, which prefers the first `main`, `article` or `[role="main"]` region, drops navigation, scripts and styles, and keeps headings. Whatever the format, the result is uploaded as a `.md` file, with the final URL in `x-blitz-source-url` so citations can link back to the page.

## The upload route

`POST /api/sources/upload` takes the body as a stream with `x-blitz-project-id` and `x-blitz-filename` headers, plus optional `x-blitz-unit-id` and `x-blitz-source-url`. It:

1. Streams the original into the project folder (`BLITZ_DATA_DIR`, default `~/Documents/Blitz`) with no size limit, hashing it as it goes.
2. Creates the source record. A file with the same content hash in the project is reported as a duplicate, with the unit it already belongs to.
3. Claims the ingestion job with a lease, extracts the text with `prepareStoredSource` (see [source extraction](source-extraction.md)), and writes its passages to `sourceChunks` in batches of 200.
4. Marks a source over 600,000 extracted characters (about 250 dense pages) as a **reference**: Teach searches it instead of teaching it as one unit.
5. Saves up to 450,000 bytes of the text on the source record. The full text stays searchable through its passages.

A file Blitz can't read (a scanned PDF, an unknown format) stays saved and is marked unreadable, so an agent can still open the original. Other failures mark the job failed and can be retried. `POST /api/sources/retry` re-reads the stored original through the same extraction; the worker's `ingestion` loop calls it to finish uploads cut off by a restart.

## The Sources page

The Sources page lists every source in the module with `sources.listForManager`, without the extracted text, so large sources don't travel to the browser. Extraction status comes from one query that reads only the newest job for each listed source, for up to 500 sources (`MAX_JOB_STATUS_SOURCES` in `convex/preparation.ts`). Progress and retry state are saved, so they survive a reload.

Sources can be renamed (the original file keeps its name), moved to another unit (`units.moveSource`) and deleted. `POST /api/sources/delete` removes the records through Convex, clears the source's passages in batches, then deletes the original from the project folder.

The Library lists projects without counting their sources or cards, so it never shows a partial count.
