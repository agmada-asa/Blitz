# Chat source citations

Chat replies can link directly to uploaded sources. A citation opens a source pane on desktop and a full-screen dialog on smaller screens. The reader scrolls to a highlighted passage, offers an original PDF view at the cited physical page, and can open independently in a new tab.

## Source storage

Project sources keep their existing ingestion and retrieval flow. Files attached directly to chat use `POST /api/chat/files`, which streams the original through the project filesystem boundary and extracts text on the server when practical. Their records live in `chatDocuments`; they do not enter the study generation queue. File attachments have no application byte or per-message count limit. Text and code are previewed within the prompt budget; binary files provide descriptors. Attached files are copied into the agent's working directory under `attachments/`, and their relative and absolute paths are provided in the prompt context. Agents use their available tools to inspect originals such as spreadsheets. Public PDF and PowerPoint links attached through chat also retain their downloaded originals. Other public links retain the extracted attachment text and an external original link.

Each persisted file attachment records its document ID. Chat submission resolves the document in the chat's owning project and ignores browser-supplied text for that document. Branches copy the document reference. Removing an unsent attachment removes it from the composer; its saved original remains in the project directory. Project deletion removes document metadata along with chat metadata and retains local bytes under the existing recovery policy.

## Generation and validation

Before generation, `chatCitations.prepare` builds a bounded manifest from saved attachments, card preparation snapshots, and project retrieval results. Teach turns supply the unit's chunks chosen by `units.teachContext` instead of a retrieval search, plus matching passages from the module's reference books. Project chunks are resolved and checked against projects in the chat context. Passage offsets refer to the exact extracted source text.

`sourcePassages` in `lib/citations.ts` splits text at explicit markers and at bounded sentence or paragraph breaks (at most 1,800 characters). A passage is labelled by its page, slide, or timestamp when it has one, otherwise by its Markdown heading, otherwise `Section N`. Headings never replace a page or slide, so a `# comment` line in lecture code keeps its page. Headings inside fenced code are ignored. Timestamps are only read outside pages and slides, so a time printed on a PDF page cannot replace the page.

The source row stores at most 450 KB of extracted text; whole books keep the rest only in their chunks. A chunk past the stored excerpt is split on its own (`chunkPassages`), takes its page from the markers ingestion recorded on the chunk, and records its `chunkId` so the reader can show the surrounding section.

The manifest contains at most 80 passages and 48,000 source characters. Selection favors passages matching the question, including explicit page requests, and reserves a passage for each represented source. A Teach turn ranks by the section being taught (`citationFocus`), because quick replies such as `Next section` contain no topic words. The latest 32 attachments and latest 24 messages bound historical reads. Previously cited passages are retained for follow-up questions and continuations, subject to the same overall limits. These limits describe the material made available to the model, not a search of every passage in every historical attachment.

The model receives the manifest as untrusted JSON and cites a supplied `citation:ID` Markdown target. IDs identify saved passages, not model-written filenames, filesystem paths, or URLs. The Markdown renderer only activates targets present in that reply's manifest. Unknown targets remain inert. This validates the citation destination, not whether the cited passage logically supports every claim; the reader makes that evidence inspectable.

The manifest is stored before streaming begins. Reloads, interrupted responses, and branches retain it. A transport retry receives the same manifest. Existing messages created before citation manifests remain readable, but their plain page mentions are not retroactively matched to potentially ambiguous sources. Asking a follow-up produces new linked citations. Originals for historical ad hoc uploads that never saved bytes cannot be recovered; their saved text remains usable as citation context.

## Reader behavior

`chatCitations.read` resolves the citation through its owning chat and message. It returns the full extracted source when available, plus the exact saved highlight range. If a source is deleted or its text changes, the saved passage is still readable. File endpoints resolve server-owned relative keys and serve only safe PDF/text formats inline; other original formats download.

PDF.js renders the requested page and highlights the text items that match the saved passage, ignoring whitespace and case (`pdfHighlightItems`). When the whole passage does not match, for example because extraction reordered columns, each sentence or line is matched separately on the cited page only. Font or layout differences can still prevent a visual match; the Passage tab always preserves the exact cited excerpt. Page numbers refer to physical PDF pages, which can differ from printed page labels.

`Open original` uses `citationOriginalUrl`: a saved PDF opens at `#page=N`, a web source opens the live page (a PDF link at its page, any other page scrolled to the passage's opening words with a `#:~:text=` fragment), and other saved originals open or download whole.

## Per source type

Every type Blitz ingests reaches Teach and chat as extracted text with explicit markers, and as chunks with the same markers, so citations behave the same in both.

| Source | Label | Where a citation opens |
| --- | --- | --- |
| PDF upload, including slides exported to PDF | `Page N` (physical page) | Original PDF tab at the page, passage highlighted; Passage tab scrolled to it |
| Whole textbook (reference book) | `Page N`, also past the 450 KB excerpt | Original PDF at the page; Passage tab shows the surrounding section |
| PowerPoint (`.pptx`) | `Slide N` | Passage tab scrolled to the slide text; the original downloads |
| Word (`.docx`) | The Word heading, else `Section N` | Passage tab scrolled to the passage; the original downloads |
| Markdown, plain notes, pasted notes | The Markdown heading, else `Section N` | Passage tab scrolled to the passage |
| `.vtt` and `.srt` transcripts, timestamped text | `m:ss` or `h:mm:ss` | Passage tab scrolled to the moment; there is no recording to seek |
| Web article or link | The page heading, else `Section N` | Passage tab; `Open original` scrolls the live page to the passage |
| PDF link | `Page N` | Passage tab; `Open original` opens the live PDF at the page |
| Research import | As its format above | Passage tab; `Open original` opens the web source as for links |
| Chat attachment | As its format above | As its format above; PDFs open the saved original at the page |

Known gaps: PowerPoint and Word originals are not rendered in the reader, so their slide or heading is shown in the extracted text only. Text fragments depend on the browser and on the live page still containing the words. Research imports made before imports were filed into units have no passages: grouped into a unit they are still taught from their text, but cannot be cited. Adding the same link again with `Add material` gives it passages.

The reader supports keyboard navigation, Escape to close, focus restoration, reduced motion, and a full-screen mobile layout. Source text and model Markdown are never injected as executable HTML.

## Verification

`tests/citations.test.ts` checks exact offsets, page boundaries, labels and anchors for each source type above, book chunks past the stored excerpt, PDF highlight matching, prompt trust boundaries, and link allowlisting. `tests/citation-persistence.test.ts` exercises the actual Convex handlers for ad hoc files, project ownership, follow-ups, branches, deleted-source fallback, and reference book passages. `tests/research-units.test.ts` checks that a research import is citable at its pages as soon as it lands. Browser verification covers a real chat reply citing an ad hoc PDF, passage and PDF highlights, reload, new-tab navigation, and desktop/mobile layouts.
