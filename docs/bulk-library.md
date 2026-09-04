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

Preparation status is requested independently by each visible source row. Each
bounded query reads only that source's newest job row, avoiding a growing
project job payload while retaining the latest retry and progress state.
