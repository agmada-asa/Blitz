# Content generation

Web and Electron source uploads queue a project-local agent job. The original
file stays in `Sources/`. Pasted notes and links use the same job after their
bounded text is stored. Research imports retain their existing import
checkpoint IDs and queue the agent for learning content.

The project has a five-step lesson detail preference. Each new job snapshots
that preference and the selected content-generation provider. Changing the
preference affects later jobs; it does not rewrite pages already published.
File-based generation currently uses Codex's workspace write sandbox. If a
different provider is selected for legacy preparation, new lessons use the
default Codex model; Settings explains this beside that choice.

The local worker gives the agent the new source, a source-ID inventory, and a
paginated export of existing learning items. It also supplies extracted source
sections when deterministic extraction succeeds. The agent writes
`manifest.json` and one JSON draft per lesson under its job's temporary
`Learning drafts/` directory. Each lesson draft contains Markdown teaching
content, exact source locations, and optional new structured questions.

The manifest accounts for each extracted section as included in a page or
skipped with a reason. If extraction is unavailable, the agent identifies
sections while reading the original and reports that coverage itself. That
case is reviewable but cannot provide the same mechanical omission check.
Draft validation checks file bounds, paths, source ownership, page length,
answer references, and complete coverage of known section IDs before any
page is imported. Raw HTML and remote images are rejected. Markdown renders
as semantic elements without executing generated HTML.

Convex remains the published source of truth. Page imports are idempotent
checkpoints. An updated lesson keeps its learning-item ID, stores its prior
text in `lessonPageRevisions`, and gains the new source reference. Unchanged
questions keep their IDs and study history; genuinely new questions are added.
Questions made inaccurate by the new source can be retired and replaced, which
resets that concept's answered-question progress so the replacement is studied.
Existing duplicate explanations for a revised concept are archived from live
views. A failed job keeps already published lessons usable and can resume its
remaining page imports from the temporary drafts. Successful jobs remove
their temporary files.

The older chunk generator remains available for legacy preparation jobs and
older mobile import paths. New web and Electron sources use the agent job.
Run `npm run worker:content` when starting services in separate terminals;
Electron and `npm run dev:lan` start it automatically. The source detail page
shows included and skipped section counts and the reasons for skipped sections.
