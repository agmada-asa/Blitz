# Local desktop roadmap

Build a Mac-only Electron app that keeps Convex, stores user files in
`~/Documents/Blitz`, gives each project an isolated agent workspace, and uses
retrieval instead of placing every source in model context.

## Implementation progress

Implemented with six Luna agents on `feat/local-desktop`. Checked items have
working code and verification evidence. The roadmap is **not complete**.

- TypeScript, ESLint, all 138 tests, and the production build pass.
- Live local checks passed for upload, retry, duplicate detection, original-file
  download, retrieval near the end of a 240 KB source, derived-text approval,
  artifact promotion, and symlink download rejection. Temporary fixtures were removed.
- Electron loaded the real interface on isolated port 3901 and shut down cleanly.
  Lifecycle tests cover worker restart bounds and service shutdown.
- The project interface was inspected at 390 px mobile and 1280 px desktop widths.
- **Blocked:** writable project agents require a runtime that enforces private
  read exclusions and read-only `Sources/` inside a writable project. The installed
  Codex app-server protocol does not provide that boundary. Task launch returns
  503 and the interface explains the unavailable capability.
- Physical Android-device testing and the complete agent/restart/phone flow remain
  unverified. Browser LAN transport and the Android upload adapter remain available.

See [local desktop host](local-desktop-host.md) for commands and limitations.

## Stage 1: project folders

- [x] Default the data root to `~/Documents/Blitz`.
- [x] Support a separate `BLITZ_DATA_DIR` for development and tests.
- [x] Create a stable, collision-safe directory for every Convex project.
- [x] Resolve stored file keys without accepting arbitrary absolute paths.
- [x] Block traversal, symlink escapes, and writes to reserved directories.

**Done when:** two same-named projects remain isolated, and path-security tests
cannot read or write outside either project.

## Stage 2: Convex file metadata

- [x] Add optional project workspace fields without breaking existing records.
- [x] Add source file metadata, including relative key, MIME type, size, and hash.
- [x] Add ingestion-job, source-chunk, artifact, and agent-task tables.
- [x] Keep file contents out of client-facing metadata queries.

**Done when:** old projects still load and a new source can be traced from its
Convex record to one project-local file.

## Stage 3: original uploads

- [x] Stream desktop and phone uploads to the Mac.
- [x] Validate, hash, and atomically copy each upload into `Sources/`.
- [x] Queue ingestion only after both the file and Convex record exist.
- [x] Detect duplicate content and make retries idempotent.
- [x] Export existing stored text as clearly labelled legacy derived files.

**Done when:** an upload survives restart, remains usable from Android, and an
interrupted upload leaves no partial source.

## Stage 4: deterministic extraction

- [x] Keep direct support for text, Markdown, text PDFs, and proven parsers.
- [x] Preserve page, slide, section, and other available source references.
- [x] Mark unsupported files as available for agent inspection.
- [x] Cache agent-derived text separately and require approval before indexing it.
- [x] Reject malformed, encrypted, empty, or oversized inputs with useful errors.

**Done when:** supported fixtures extract repeatably, while every unsupported file
is retained without being presented as searchable evidence.

## Stage 5: retrieval

- [x] Persist bounded source chunks, outlines, hashes, and references in Convex.
- [x] Add exact-text search and tools to read chunks and neighboring sections.
- [x] Assemble bounded, deduplicated context with citations.
- [x] Make card generation traverse all source sections rather than search alone.
- [x] Add semantic retrieval only if a fixed evaluation set shows a clear gain.

Semantic retrieval remains omitted. The fixed lexical fixtures pass; no measured
semantic gain justifies an additional indexing service.

**Done when:** questions can find cited facts near the end of large sources without
prompt size growing with the full project library.

## Stage 6: project agents and artifacts

- [ ] Start every agent in the selected project directory.
- [ ] Give agents read-only access to `Sources/` and no access to `.blitz/`.
- [ ] Allow agents to create folders and files elsewhere in that project.
- [ ] Register created, changed, moved, and deleted artifacts in Convex.
- [x] Add an explicit `Add to sources` action for generated artifacts.
- [ ] Disable network access unless the user starts a research task.

**Done when:** an agent can create and reopen coursework in one project but cannot
access another project or modify an original source.

## Stage 7: local Electron host

- [x] Add an Electron main process and safe preload bridge.
- [x] Open the existing Next.js interface in a `BrowserWindow`.
- [x] Start and stop Next.js, local Convex, workers, and Codex cleanly.
- [x] Add health checks, single-instance locking, and bounded service restarts.
- [x] Add native file selection, open-file, and reveal-in-Finder actions.
- [x] Keep the existing browser and Android LAN flows working.

**Done when:** `npm run desktop` opens Blitz, recovers from one worker failure, and
shuts down without leaving managed processes running.

## Stage 8: interface and verification

- [x] Add a project file browser with source, ingestion, and artifact states.
- [x] Show retrieval citations and clear unsupported-file status.
- [ ] Show agent progress and provide direct access to created files.
- [ ] Test restarts, retries, duplicates, malicious paths, and prompt injection.
- [x] Verify affected flows at mobile and desktop widths with keyboard access.
- [x] Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

**Done when:** the full upload, retrieve, create-artifact, restart, and phone-access
flows pass without exposing files outside the active project.

## Not in the current scope

- SQL migration
- Symlink imports
- Signed installer, notarization, or automatic updates
- Automatic indexing of agent-generated work
- Public internet access to the local agent
- Cross-computer file synchronization
- Windows or Linux packaging
