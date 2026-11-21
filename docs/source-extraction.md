# Source extraction

`lib/server/source-ingestion/extract.ts` turns a file into readable text. It has two entry points that share the same format readers:

- `extractStoredSource` reads an original saved in the project folder. Uploads, retries and chat attachments use it, through `prepareStoredSource` (`prepare.ts`), which also normalizes and chunks the text (see [source ingestion](source-ingestion.md)).
- `extractDownloadedSource` reads bytes already downloaded by `fetchPublicSource`. Research imports use it.

Neither fetches URLs, follows links, runs downloaded markup or does OCR.

## Formats

The format comes from the file's first bytes, its content type and its extension.

| Format | How it's read | Saved as |
| --- | --- | --- |
| PDF | `pdfjs-dist` | `pdf` |
| PowerPoint `.pptx` | slide XML, `[Slide N]` markers | `text` |
| Word `.docx` | `word/document.xml` to Markdown | `markdown` |
| Markdown | as is | `markdown` |
| HTML | main text, headings kept | `text` |
| Text, code, CSV, JSON, subtitles | as is | `text` |

**PDF.** Evaluation is turned off where supported. Positioned text is sorted into lines and into common two- or three-column reading order (`pdf-reading-order.ts`), and each page starts with a `[Page N]` marker. Project files are read with file-backed range reads, so a large PDF doesn't need the same amount of memory. A PDF with no text layer fails with a message saying it needs OCR.

**PowerPoint.** Only `ppt/slides/slideN.xml` entries are read: at most 1 MB per slide and 20 MB across all slides. Slides are numbered by part name (`slide7.xml` is Slide 7). A deck with no readable slide text fails as unreadable.

**Word.** Only `word/document.xml` is read (at most 30 MB unzipped). `Title` and `Heading N` styles or outline levels become `#` headings, numbered and bulleted paragraphs become `- ` items, and tabs and line breaks are kept. Word has no fixed pages, so no page markers are invented; citations name the heading instead. Text boxes, tables and footnotes come through only as far as their paragraphs sit in the body.

**HTML.** A small server-side reader, not a full HTML parser: it takes the first `main` or `article` region if there is one, removes scripts and styles, decodes common entities, turns `h1`–`h6` into Markdown headings and keeps block boundaries. Links added in the browser are parsed with `DOMParser` instead; see [adding material](source-import.md).

**Subtitles.** `.vtt` and `.srt` files are turned into a timestamped transcript, so citations can point at a time.

## Limits

| Limit | Stored files | Downloads |
| --- | --- | --- |
| File size | none for most formats; PPTX and DOCX 20 MB | 5 MB |
| PDF pages | 3,000 | 500 |
| Extracted text | 20,000,000 characters | 2,000,000 characters |

Text over the limit fails with `input-too-large` rather than being cut short. Empty documents fail with a clear message. When extraction fails, the original stays saved, so an agent can still open it with its own tools.

## Showing the original

`lib/source-viewers.ts` picks how a source opens in the reader: PDFs in a PDF viewer, Word files in a document view (`docx-preview`, in a shadow root), and PowerPoint decks as slides. `lib/client/pptx-slides.ts` reads a deck in the browser into a simple slide model that `components/ui/slides-reader.tsx` draws. It keeps positioned text with its styling, pictures, tables, solid fills and backgrounds, resolves layout and master inheritance, and applies theme colours. It leaves out charts, SmartArt, effects, gradients and EMF/WMF pictures. It uses the same slide numbering as extraction, so a cited slide and the drawn slide always match.

Everything else opens as `Formatted` Markdown, up to 400,000 characters. See [chat citations](chat-citations.md) for how a citation finds its passage.
