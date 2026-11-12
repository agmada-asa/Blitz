# Bulk library reads

The project library returns project rows without scanning each project's
sources, cards, or learning items. Counts derived from those collections are
therefore intentionally omitted; the library never presents a partial count as
if it were exact.

Project sources are loaded through Convex pagination in pages of 20. The
project view keeps every loaded source's metadata and offers **Load more
sources** until the query reports that the complete collection has been read.
The source query removes `extractedText` from each returned row, so large
uploads do not travel to the browser with metadata.

Preparation status is requested for every listed source in one query, which
reads only each source's newest job row. That avoids a growing project job
payload while retaining the latest retry and progress state. The query accepts
up to `MAX_JOB_STATUS_SOURCES` (500) sources; it once allowed 20, which made
the Sources page fail for any module with more than 20 sources.
