# Find sources

`Find sources` asks a provider to propose what to learn and which public pages to read, then imports the pages the learner picks. Nothing is imported until the learner approves it.

## In the app

The Sources page of a module has an `Ask Blitz to find sources` button that opens `ResearchPanel` (`components/projects/research-panel.tsx`) in a dialog. A unit's menu on the module page also has `Find sources`, which opens `/projects/[projectId]/sources?unit=…` with that unit picked.

The learner describes what they want to learn and presses `Find sources`. The panel restores the latest proposal after a reload and polls it every three seconds while the dialog is open. Closing the dialog while it works shows `Finding sources in background`; the request carries on in the worker.

A ready proposal shows a short scope, optional topics, suggested links with reasons, and outlines of notes Blitz could write. Suggested links sit under `Suggested sources`; they came from a web search and have not been read. The note outlines are previews only, and nothing creates those notes yet.

The learner ticks sources, picks a unit under `Add to` (`New unit`, or any unit in the module) and presses `Import selected`. Each source then shows queued, importing, imported or failed. A failed source shows why and has `Retry`, which imports it into the unit chosen at that moment. An imported source says `Added to <unit>` with `Start learning`, which opens that unit's Teach session. Closing the dialog during imports shows `Importing sources in background`.

While planning, the dialog shows the latest stage and the elapsed time, with the full trace under `Activity details`. `BackgroundNotices` (`components/background-notices.tsx`) shows these notices for eight seconds and keeps them across navigation.

## Planning

`POST /api/research/proposals` takes `projectId`, `requestId` and the request text (at most 2,000 characters) and queues one idempotent planning request. `GET /api/research/proposals?projectId=…&requestId=…` returns its state; without `requestId` it lists recent proposals (`limit` 1–20). A proposal moves through `queued`, `running`, `searching`, `synthesizing`, then `completed` or `failed`. `POST /api/research/proposals/retry` retries a failed one.

The planner is the `research` loop of the background worker (`scripts/worker.ts`; see [architecture](architecture.md#the-background-worker)). It uses the provider and model saved for Research in Settings, which defaults to Codex with `gpt-6-luna`. A research turn keeps only the provider's own web search and page fetch: files, commands and edits are off, Codex runs with a read-only sandbox and approvals declined, and on Codex web search is turned on only for this process. A turn times out after 120 seconds, and a reply that isn't valid JSON gets one repair attempt.

The worker only saves suggested links if it saw the provider actually search: Codex and Claude Code report a `web-search` tool, and the ACP runtimes a built-in tool named like `search_web` (Antigravity) or `websearch` (OpenCode). Links are saved as `suggested-unverified`. Planned notes carry the fixed `generated` label.

A proposal keeps up to 32 activity events: queued, started, each search query (capped at 500 characters), assembly, completion and failure. Raw tool results and reasoning are not kept.

## Importing approved sources

`POST /api/research/proposals/apply` takes `projectId`, `requestId`, 1–20 `sourceIndexes` from the stored proposal, and an optional `unitId`. It sends indexes only; the server reads the URLs from the saved proposal. Repeating the request is safe: imported sources stay imported, running ones are left alone, and a failed one is queued again.

Every import is filed into a unit so Teach can use it straight away. With `unitId`, sources join that unit. Without it, they join one new unit per research request, created at the end of the learning path and titled from the request by `researchUnitTitle` (`lib/research-unit.ts`): `help me learn graph algorithms` becomes `Graph algorithms`. The title is marked `auto`, so the tutor can retitle the unit when it first teaches it. If the picked unit was deleted before the import ran, the server uses the research's own new unit instead.

`GET /api/research/proposals/imports?projectId=…&requestId=…` returns each selected source's status, unit, and source and job IDs.

The worker downloads each page with `fetchPublicSource` (20 second deadline, at most 5 MB, three redirects; see [source ingestion](source-ingestion.md#public-urls)) and extracts it with `extractDownloadedSource` (see [source extraction](source-extraction.md)). An article link that redirects to the site's home page is rejected. Failures get a fixed `failureCategory`: `site-refused`, `not-found`, `unsupported-format`, `needs-ocr`, `too-large`, `timeout`, `invalid-url` or `download-failed`, with recovery copy for each.

### Large downloads

Extracted text above 120,000 characters is split by `splitSourceText` (`lib/source-splitting.ts`, up to 2,000,000 characters). Splits prefer line breaks and whitespace and never break a UTF-16 surrogate pair. Each part's text starts with a visible `[Part N of M]` line, its filename keeps the extension (`manual (Part 2 of 4).pdf`), and the part bodies joined together give back the full text. All parts go into the same unit.

Each part is chunked with `prepareTextSource`, the same passages and page, slide and timestamp references uploads get. `research.completeImport` checks every passage is an exact slice of the stored text, then creates the source, its passages and a completed preparation job in one transaction; those IDs are the import's checkpoint. The lease is held until the last part. On a retry, parts already saved must match the newly downloaded text, so a page that changed in between fails instead of mixing two versions.
