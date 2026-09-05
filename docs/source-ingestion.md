# Source ingestion boundary

`lib/server/source-ingestion` is the server-side boundary between source extraction and later concept or card generation. It accepts already extracted text, normalizes line endings, keeps source identity stable, preserves explicit attribution markers, and emits bounded chunks with deterministic IDs.

Supported normalized kinds are `pdf`, `markdown`, `text`, `transcript`, `powerpoint`, and `url`. The kind describes an upstream adapter; this layer does not pretend to parse binary PowerPoint files or HTML. The current browser extractor supports PDF, Markdown, and text. A future PowerPoint adapter should pass extracted text with explicit `[Slide …]` markers, and a future PDF adapter can continue to pass the existing `[Page N]` markers.

Markers are recognized only when they are explicit line prefixes: `[Page …]`, `[Slide …]`, bracketed timestamps such as `[00:01:23]`, and timestamp prefixes such as `00:01:23 Speaker:`. The marker label is retained in the normalized text and in each intersecting source reference. No page, slide, or timestamp marker is manufactured when the input does not contain one. A filename is retained when supplied; paste sources can remain unattributed beyond their stable source ID.

`segmentSourceDocument` defaults to 5,000 characters per chunk, 400 characters of overlap, and at most 1,000 chunks. It chooses paragraph, line, or whitespace boundaries where possible, but falls back to an exact hard boundary for long unbroken text. Chunks are exact slices of normalized text, so removing each adjacent overlap reconstructs the complete normalized source. Chunk IDs hash the source ID, ordinal, offsets, and text, making repeated processing deterministic without exposing source text in identifiers.

Normalization rejects empty input, filenames longer than 255 characters, and text above 2,000,000 characters or 8,000,000 UTF-8 bytes. Segmentation reports the source ID and configured chunk limit when the maximum chunk count is exceeded. `SourceIngestionError` exposes a stable error code and safe bounded context without storing source contents.

Large browser imports use the shared bounded splitter described in
`docs/source-splitting.md`; source parts retain their complete extracted text
and visible part attribution instead of truncating at the persistence limit.

`fetchPublicSource` is a small optional URL adapter. It accepts only HTTP(S), rejects userinfo and nonstandard ports, blocks localhost and local hostnames, resolves every hostname and rejects private, link-local, documentation, multicast, and other non-public addresses, validates each redirect, and enforces one total deadline plus a response byte cap. Its default Node `http`/`https` transport connects through the validated DNS address while retaining the original hostname for TLS SNI and `Host`, which prevents a second DNS lookup from rebinding the request. The injectable fetch implementation exists for deterministic tests and must not be used as an unpinned production transport. It returns bounded bytes and content type; it does not parse HTML. Requests do not use browser cookies or local file access. HTML extraction needs a vetted parser dependency or a dedicated upstream adapter before web pages can be treated as faithful learning sources.
