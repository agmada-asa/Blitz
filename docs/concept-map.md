# Concept map

The project map uses the existing `concepts` table as its node inventory. A
concept is a taught idea, so repeated mentions from different sources reuse its
ID and may add alternate names. The `conceptRelationships` table stores a
directed, typed link supported by one source. Symmetric `contrasts_with` and
`related_to` links use a stable endpoint order. Each row keeps a short
explanation and one to four source locations; separate rows let multiple files
support the same connection without merging their evidence.

Content generation receives the saved map alongside the existing learning path
and source inventory. The prompt asks the agent to follow relevant links to
original files and check the evidence before changing a lesson. Its manifest
may link a new draft page to another draft page or to an existing concept ID.
It should omit relationships that the current source does not support.
Workers claim only one active source job per project, so later files in a batch
read the links committed by earlier files. Other projects can generate at the
same time.

The worker checks every endpoint and evidence section before import. Convex
checks project ownership again when the job finishes, resolves page keys to
saved concept IDs, replaces that source's previous links, and completes the
job atomically. A retry cannot leave a completed job with only some of its
links. Project deletion removes relationship rows with other project data.

`/projects/:projectId/map` lists all current concepts, including older
concepts that have no saved links yet. Selecting one shows its connections and
the original source locations. It is linked from the Sources workspace. The
map is bounded to the same size as the current learning path; larger projects
need pagination before that limit can grow.
