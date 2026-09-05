# Research proposal UI

`ResearchPanel` is a project-scoped, approval-first entry. The collapsed
`Find sources` button opens a dialog where a learner describes what they want
to learn. `POST /api/research/proposals` queues the request with a stable
request ID for that request text. The panel restores the latest project
proposal after reload and polls its server-owned state every three seconds,
including while the dialog is closed. Closing a queued request shows a short
`Finding sources in background` notice; the project entry keeps the elapsed
status visible until the persisted request finishes or fails.

Ready proposals show a concise scope, optional topics, source links and reasons,
plus planned note outlines. Suggested sources carry the single label `Suggested
sources · not checked yet`. Nothing is imported while planning. The learner
selects sources and clicks `Import selected`, which sends `{ projectId,
requestId, sourceIndexes }` to `/api/research/proposals/apply`.

After apply, the panel polls `GET /api/research/proposals/imports?projectId=…&requestId=…`
for each source's queued, importing, imported, or failed state. A failed source
has its error and an explicit `Retry` action, which retries that source through
the apply endpoint. Imported and active source rows cannot be selected again.
Downloaded sources then show preparation progress, Ready, No study content,
or Needs retry. Each row reads at most 20 preparation jobs in its own bounded
query; larger imports do not claim complete coverage from a partial read.
Closing an active import shows `Importing sources in
background`; this notice is transient while the per-source state remains
persisted on the project.

Active proposals may include a bounded activity trace with queued, searching,
source preparation, and completion stages. The dialog shows the latest stage
and elapsed time, with the trace available under `Activity details`; it omits
worker logs and reasoning.

`BackgroundNotices` is mounted above the shared shell. Its eight-second notices
survive client navigation and can be dismissed. Source uploads and saved card
replies use the same provider. Closing a pending chat links directly back to its
saved conversation.

Failed planning requests preserve their request ID and offer the explicit
`/api/research/proposals/retry` action. Planned note outlines remain previews only. This version imports selected external sources; it does not create the proposed notes.
