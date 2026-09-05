# Local desktop host

`npm run desktop` starts the Mac-only Electron shell for Blitz. The shell starts
the same local services as the LAN launcher on loopback: Convex at `3210`, its
site server at `3211`, Next at `3001`, and the ingestion, preparation, chat, and research
workers. The BrowserWindow waits for Next to answer before it loads the app.

The desktop supervisor owns each process group. Closing the window or quitting
the app sends `SIGTERM` to every group and escalates to `SIGKILL` after three
seconds, so workers and their Codex child processes do not remain behind. A
worker may restart once after an unexpected exit; a second failure stops that
worker and leaves the saved queue state available for a deliberate retry. Next or
Convex failure stops the host immediately. Startup waits up to 30 seconds for
the loopback Next health check (override with
`BLITZ_DESKTOP_HEALTH_TIMEOUT_MS`).

The host takes the normal `.env.local` configuration and supports
`BLITZ_PORT` plus `BLITZ_DATA_DIR`. The data root defaults to
`~/Documents/Blitz`; project-scoped native actions resolve files under the
same hashed `Projects/project-<id-hash>` layout used by the local file store.
The preload bridge exposes only service status, open, and Finder reveal methods.
Uploads use Chromium's file input and streaming request body, avoiding a second
full-file copy through Electron IPC. Renderer access uses
context isolation, disabled Node integration, and a sandboxed preload. Native
paths are checked after realpath resolution to block traversal and symlink
escapes.

The existing `npm run dev:lan` flow is unchanged. For a desktop session that
also serves browser or Android clients, set `BLITZ_LAN_ADDRESS` to the Mac's
LAN address before `npm run desktop`; the host then binds Next for that LAN
while the BrowserWindow continues to use loopback. The desktop host is
intentionally not a packaged installer yet.

## Source files and retrieval

Original uploads use `POST /api/sources/upload` with `x-blitz-project-id`,
`x-blitz-filename`, and the raw file body. The same endpoint accepts browser,
Electron, and Android LAN requests. Uploads have a 1 GiB byte limit. Local PDF
extraction uses file-backed range reads, while approved public research downloads
retain their separate 5 MB network boundary. Persisted extracted text is limited
to 500 KB in UTF-8. Inputs that cross a later parsing or text limit stay retained
with an actionable error; Blitz never silently truncates searchable evidence.

`worker:ingestion` recovers queued uploads and expired five-minute ingestion
leases through `/api/sources/retry`. Failed files require an explicit retry.
Ingestion completion and resumable card preparation are recorded in the same
Convex transaction. The preparation worker walks every source chunk.

Chat searches indexed chunks for each question, including projects attached in
earlier turns. Context is bounded and retains filename and location citations.
Exact text search remains the retrieval baseline; semantic indexing is not enabled.

Derived text is cached privately with `POST /api/projects/<id>/derived` using
`sourceKey` and `text`. `GET` lists review metadata, and `GET ?id=<id>` returns
bounded review text. An explicit POST with `action: "approve"` and the item ID
imports a labelled derived source through normal ingestion. Pending items are
not indexed. The artifact `Add to sources` action also copies its bytes into
`Sources/` through normal ingestion.

For legacy text, `node --experimental-strip-types scripts/export-legacy-sources.ts <export.json>` previews a supplied Convex export. Add `--write` to create labelled
legacy derived files. This is an explicit migration utility; existing projects
are not silently rewritten. Existing legacy text needs indexing before it can
participate in chunk retrieval.

The default data directory may also be the development checkout. `Projects/`
and `.next-*` are therefore excluded from Git, lint, and Tailwind scanning.
Deleting a Convex project removes its associated metadata but retains local files
for recovery.

## Remaining agent limitation

Writable project-agent execution is disabled. The installed app-server protocol
supports broad workspace writes but does not provide the external filesystem
broker needed to exclude `.blitz/` reads and `Sources/` writes while allowing
other project files. The API returns 503, and the interface shows the capability
as unavailable. No prompt-only restriction or unrestricted fallback is used.

The task and artifact tables, scoped file access, and explicit promotion action
are available. Automatic creation, move/delete synchronization, and agent recovery
still need an enforceable execution backend. Physical Android and the complete
agent/restart/phone workflow have not been verified.

## Verification

Verified locally with TypeScript, ESLint, 138 Node tests, and a production build.
Live fixture checks covered a 240 KB upload with a cited fact at chunk 53,
original-byte downloads, duplicates, retry, derived approval gating, artifact
promotion, and denied symlink downloads. Temporary fixture projects were deleted.
Electron loaded Blitz on port 3901 with an isolated Next output directory and
shut down cleanly. The project file interface was inspected at 390 px and 1280 px.
