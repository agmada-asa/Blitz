# Local desktop roadmap

Build a Mac-only Electron app that keeps Convex, stores user files in
`~/Documents/Blitz`, gives each project an isolated agent workspace, and uses
retrieval instead of placing every source in model context.

## Stage 1: project folders

- [ ] Default the data root to `~/Documents/Blitz`.
- [ ] Support a separate `BLITZ_DATA_DIR` for development and tests.
- [ ] Create a stable, collision-safe directory for every Convex project.
- [ ] Resolve stored file keys without accepting arbitrary absolute paths.
- [ ] Block traversal, symlink escapes, and writes to reserved directories.

**Done when:** two same-named projects remain isolated, and path-security tests
cannot read or write outside either project.

## Stage 2: Convex file metadata

- [ ] Add optional project workspace fields without breaking existing records.
- [ ] Add source file metadata, including relative key, MIME type, size, and hash.
- [ ] Add ingestion-job, source-chunk, artifact, and agent-task tables.
- [ ] Keep file contents out of client-facing metadata queries.

**Done when:** old projects still load and a new source can be traced from its
Convex record to one project-local file.

## Stage 3: original uploads

- [ ] Stream desktop and phone uploads to the Mac.
- [ ] Validate, hash, and atomically copy each upload into `Sources/`.
- [ ] Queue ingestion only after both the file and Convex record exist.
- [ ] Detect duplicate content and make retries idempotent.
- [ ] Export existing stored text as clearly labelled legacy derived files.

**Done when:** an upload survives restart, remains usable from Android, and an
interrupted upload leaves no partial source.

## Stage 4: deterministic extraction

- [ ] Keep direct support for text, Markdown, text PDFs, and proven parsers.
- [ ] Preserve page, slide, section, and other available source references.
- [ ] Mark unsupported files as available for agent inspection.
- [ ] Cache agent-derived text separately and require approval before indexing it.
- [ ] Reject malformed, encrypted, empty, or oversized inputs with useful errors.

**Done when:** supported fixtures extract repeatably, while every unsupported file
is retained without being presented as searchable evidence.

## Stage 5: retrieval

- [ ] Persist bounded source chunks, outlines, hashes, and references in Convex.
- [ ] Add exact-text search and tools to read chunks and neighboring sections.
- [ ] Assemble bounded, deduplicated context with citations.
- [ ] Make card generation traverse all source sections rather than search alone.
- [ ] Add semantic retrieval only if a fixed evaluation set shows a clear gain.

**Done when:** questions can find cited facts near the end of large sources without
prompt size growing with the full project library.

## Stage 6: project agents and artifacts

- [ ] Start every agent in the selected project directory.
- [ ] Give agents read-only access to `Sources/` and no access to `.blitz/`.
- [ ] Allow agents to create folders and files elsewhere in that project.
- [ ] Register created, changed, moved, and deleted artifacts in Convex.
- [ ] Add an explicit `Add to sources` action for generated artifacts.
- [ ] Disable network access unless the user starts a research task.

**Done when:** an agent can create and reopen coursework in one project but cannot
access another project or modify an original source.

## Stage 7: local Electron host

- [ ] Add an Electron main process and safe preload bridge.
- [ ] Open the existing Next.js interface in a `BrowserWindow`.
- [ ] Start and stop Next.js, local Convex, workers, and Codex cleanly.
- [ ] Add health checks, single-instance locking, and bounded service restarts.
- [ ] Add native file selection, open-file, and reveal-in-Finder actions.
- [ ] Keep the existing browser and Android LAN flows working.

**Done when:** `npm run desktop` opens Blitz, recovers from one worker failure, and
shuts down without leaving managed processes running.

## Stage 8: interface and verification

- [ ] Add a project file browser with source, ingestion, and artifact states.
- [ ] Show retrieval citations and clear unsupported-file status.
- [ ] Show agent progress and provide direct access to created files.
- [ ] Test restarts, retries, duplicates, malicious paths, and prompt injection.
- [ ] Verify affected flows at mobile and desktop widths with keyboard access.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

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
