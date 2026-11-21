# Source ingestion

`lib/server/source-ingestion/` turns extracted text into the passages Teach, chat and citations search. It sits between [extraction](source-extraction.md) and persistence:

1. **Extract**: `extract.ts` reads a file into text.
2. **Normalize**: `normalize.ts` cleans the text, gives the source a stable ID and finds page, slide and timestamp markers.
3. **Segment**: `segment.ts` cuts the text into overlapping passages with deterministic IDs.
4. **Rows**: `chunk-rows.ts` turns passages into `sourceChunks` rows.

`prepareStoredSource` (`prepare.ts`) runs all four for uploads. Research imports call `prepareTextSource` (`chunk-rows.ts`) on each downloaded part. Both produce identical passages and references.

## Normalization

`normalizeSourceDocument` strips a byte-order mark, turns CRLF into LF and checks the kind (`pdf`, `markdown`, `text`, `transcript`, `powerpoint` or `url`). Extraction currently produces only `pdf`, `markdown` and `text`; the other kinds are there for adapters. Without a supplied `sourceId`, it hashes the kind, filename and text into one.

Markers are recognised only as explicit line prefixes: `[Page …]`, `[Slide …]`, bracketed timestamps such as `[00:01:23]`, and timestamp prefixes such as `00:01:23 Speaker:`. The marker label stays in the text and in every passage it covers. No marker is invented when the text has none, so pasted notes are cited by section only.

It rejects empty text, filenames over 255 characters, and text over 20,000,000 characters or 25,000,000 UTF-8 bytes.

## Segmentation

`segmentSourceDocument` defaults to 5,000 characters per passage, 400 characters of overlap and at most 1,000 passages. Uploads raise the cap to 6,000 passages (`MAX_PREPARED_CHUNKS`), about 25 MB of text, which is enough for a whole textbook. Cuts fall on paragraph, line or whitespace boundaries where possible, and fall back to a hard cut in long unbroken text.

Passages are exact slices of the normalized text, so removing each overlap gives back the full source. Passage IDs hash the source ID, position, offsets and text, so processing the same source twice gives the same IDs without putting source text in the ID.

`SourceIngestionError` (`errors.ts`) carries a stable code (for example `input-too-large`, `invalid-input`, `url-timeout`) and small, safe context, never the source text. Upload and import routes use the code to choose their recovery message.

## Public URLs

`fetchPublicSource` (`url.ts`) downloads a public page for [adding material](source-import.md) and [Find sources](research.md). It:

- accepts only HTTP(S) URLs, with no user info and no non-standard ports;
- blocks localhost and local hostnames, resolves every hostname and rejects private, link-local, documentation, multicast and other non-public addresses;
- checks every redirect the same way, with a single deadline for the whole request and a cap on response bytes;
- connects to the checked IP address while keeping the original hostname for TLS and `Host`, so a second DNS lookup can't point the request somewhere else;
- sends no cookies and never reads local files.

It returns the bytes and content type and does not parse anything. Callers set the limits: the link route uses 5 MB, 15 seconds and three redirects, and research imports use a 20 second deadline. The `fetchImpl` option is for tests only and must not be used in production, because it skips the pinned connection.
