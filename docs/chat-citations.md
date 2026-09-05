# Chat source citations

Chat replies can link directly to uploaded sources. A citation opens a source pane on desktop and a full-screen dialog on smaller screens. The reader scrolls to a highlighted passage, offers an original PDF view at the cited physical page, and can open independently in a new tab.

## Source storage

Project sources keep their existing ingestion and retrieval flow. Files attached directly to chat use `POST /api/chat/files`, which streams the original through the project filesystem boundary and extracts text on the server. Their records live in `chatDocuments`; they do not enter the study generation queue. PDF, PowerPoint, Markdown, and text uploads are supported, with a 50 MB original limit and a 500 KB extracted-text limit. Public PDF and PowerPoint links attached through chat also retain their downloaded originals. Other public links retain the extracted attachment text and an external original link.

Each persisted file attachment records its document ID. Chat submission resolves the document in the chat's owning project and ignores browser-supplied text for that document. Branches copy the document reference. Removing an unsent attachment removes it from the composer; its saved original remains in the project directory. Project deletion removes document metadata along with chat metadata and retains local bytes under the existing recovery policy.

## Generation and validation

Before generation, `chatCitations.prepare` builds a bounded manifest from saved attachments, card preparation snapshots, and project retrieval results. Project chunks are resolved and checked against projects in the chat context. Passage offsets refer to the exact extracted source text. Explicit page, slide, timestamp, and Markdown heading markers provide labels; an unlabeled passage receives a section label.

The manifest contains at most 80 passages and 48,000 source characters. Selection favors passages matching the question, including explicit page requests, and reserves a passage for each represented source. The latest 32 attachments and latest 24 messages bound historical reads. Previously cited passages are retained for follow-up questions and continuations, subject to the same overall limits. These limits describe the material made available to the model, not a search of every passage in every historical attachment.

The model receives the manifest as untrusted JSON and cites a supplied `citation:ID` Markdown target. IDs identify saved passages, not model-written filenames, filesystem paths, or URLs. The Markdown renderer only activates targets present in that reply's manifest. Unknown targets remain inert. This validates the citation destination, not whether the cited passage logically supports every claim; the reader makes that evidence inspectable.

The manifest is stored before streaming begins. Reloads, interrupted responses, and branches retain it. A transport retry receives the same manifest. Existing messages created before citation manifests remain readable, but their plain page mentions are not retroactively matched to potentially ambiguous sources. Asking a follow-up produces new linked citations. Originals for historical ad hoc uploads that never saved bytes cannot be recovered; their saved text remains usable as citation context.

## Reader behavior

`chatCitations.read` resolves the citation through its owning chat and message. It returns the full extracted source when available, plus the exact saved highlight range. If a source is deleted or its text changes, the saved passage is still readable. File endpoints resolve server-owned relative keys and serve only safe PDF/text formats inline; other original formats download.

PDF.js renders the requested page and highlights text items matching the saved passage. PDF layout, extraction, or font differences can prevent visual matching; the Passage tab always preserves the exact cited excerpt. Page numbers refer to physical PDF pages, which can differ from printed page labels. PowerPoint slide and transcript timestamp citations navigate their extracted text; their originals remain available separately.

The reader supports keyboard navigation, Escape to close, focus restoration, reduced motion, and a full-screen mobile layout. Source text and model Markdown are never injected as executable HTML.

## Verification

`tests/citations.test.ts` checks exact offsets, page boundaries, stable source text, prompt trust boundaries, and link allowlisting. `tests/citation-persistence.test.ts` exercises the actual Convex handlers for ad hoc files, project ownership, follow-ups, branches, and deleted-source fallback. Browser verification covers a real chat reply citing an ad hoc PDF, passage and PDF highlights, reload, new-tab navigation, and desktop/mobile layouts.
