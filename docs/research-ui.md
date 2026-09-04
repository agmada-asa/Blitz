# Research proposal UI

`ResearchPanel` is a project-scoped, approval-first entry. The collapsed
`Find sources` button opens a dialog where a learner describes what they want
to learn. `POST /api/research/proposals` queues the request with a stable
request ID for that request text. The dialog polls `GET
/api/research/proposals` every three seconds while open and restores the latest
project proposal when reopened.

Ready proposals show a concise scope, optional topics, source links and reasons,
plus planned note outlines. Suggested sources carry the single label `Suggested
sources · not checked yet`. Nothing is imported while planning. The learner
selects sources and clicks `Import selected`, which sends `{ projectId,
requestId, sourceIndexes }` to `/api/research/proposals/apply`.

After apply, the panel polls `GET /api/research/proposals/imports?projectId=…&requestId=…`
for each source's queued, importing, imported, or failed state. A failed source
has its error and an explicit `Retry` action, which retries that source through
the apply endpoint. Imported and active source rows cannot be selected again.

Failed planning requests preserve their request ID and offer the explicit
`/api/research/proposals/retry` action. Planned note outlines remain previews only. This version imports selected external sources; it does not create the proposed notes.
