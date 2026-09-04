# Research proposals

`POST /api/research/proposals` accepts `projectId`, `requestId`, and a learner request such as `help me learn sound design`. It queues one idempotent planning request. `GET /api/research/proposals?projectId=...&requestId=...` polls its status; omitting `requestId` lists the 20 most recent proposals for reload. When ready, a proposal returns a bounded scope, topic names, suggested URLs with titles and reasons, and outlines for notes Blitz could create.

Proposal planning happens on the local Mac through the Codex app-server worker. It does not fetch, download, import, apply, or create any source or lesson content. Suggested URLs are recorded as `suggested-unverified`; the planner does not claim that it checked them. Planned notes carry the fixed `generated` label and contain an outline only. A later approval flow owns source retrieval and note creation.

The queue has bounded leases, idempotent request IDs, safe failure text, and an explicit retry endpoint at `/api/research/proposals/retry`. The worker uses the stable external Blitz workspace and read-only sandbox with approval requests declined, and defaults to `gpt-5.6-luna`. `scripts/research-worker.ts` can be run with `--once` for one poll; it never exposes Codex credentials.

## Applying approved sources

The interface must send an explicit `POST /api/research/proposals/apply` with `projectId`, `requestId`, and selected `sourceIndexes` from the stored ready proposal. It sends indexes only; the server resolves URLs from that immutable proposal. Repeating the request is safe: imported sources remain imported, queued or running imports remain unchanged, and a failed selected import is deliberately requeued.

Poll `GET /api/research/proposals/imports?projectId=...&requestId=...` for an `imports` array containing each selected source index, status, and resulting source and preparation job IDs. The local worker performs bounded public URL validation, follows at most three redirects, retains at most 5 MB, extracts readable PDF, PPTX, Markdown, HTML, or text, and atomically creates the source and queued preparation job. Failed imports include a fixed `failureCategory` such as `site-refused`, `not-found`, `unsupported-format`, `needs-ocr`, `too-large`, `timeout`, or `download-failed`, plus safe recovery copy. Retry a failed item deliberately with another explicit apply request. No planned generated note is created in this flow.
