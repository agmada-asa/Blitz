# Large source uploads

`lib/source-splitting.ts` keeps large extracted files usable with the Convex
source document limit. It accepts at most 2,000,000 characters and splits larger
text into parts whose stored text stays below 120,000 characters, leaving room
for a visible `[Part N of M]` attribution header. Boundaries prefer line breaks
and whitespace and never split a UTF-16 surrogate pair. The part bodies are
exact slices of the extracted input, so concatenating them reconstructs the
complete text.

`SourceUploader` saves parts sequentially. If a later part fails, earlier parts
remain saved and the import result reports the partial outcome. Part filenames
retain the original extension, for example `manual (Part 2 of 4).pdf`.

`createAndEnqueue` saves each source part and its preparation job atomically.
It computes and indexes a deterministic fingerprint for each part,
then verifies filename, kind, text, and URL on the indexed candidate. This makes
a retry safe after a lost response without scanning every large source or
trusting a client supplied key. Re-uploading a failed part resumes its existing
job without resetting completed sections. The older `createSource` mutation
uses the same indexed lookup.

Approved research imports use the same splitter. Each part commits under the
import's lease and retains its source and job IDs. Retries verify saved parts
against the newly fetched content before continuing; a changed source is
rejected instead of mixing versions. The download remains capped at 5 MB and
the extracted text at 2,000,000 characters. Each persisted part stays within
the existing 120,000 character document limit.

File extraction and upload run in the browser, so the page must stay open until
the parts are saved. The notice then confirms that card preparation continues
in the background. A lost connection preserves earlier parts; selecting the
same file again safely resumes the upload.
