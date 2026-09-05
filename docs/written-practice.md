# Written practice

Written practice is an explicitly selected activity inside a project. It can
be scoped to a project or one of its topics and uses only persisted `explain`
learning items as prompts. Each activity contains at most five prompts from a
bounded scan of at most 2,000 learning items, ordered by persistence time.
Activities continue after the last completed prompt. The last activity may
contain fewer than five prompts; a subsequent activity wraps only after the
actual end of the project. Reaching the scan bound without a matching prompt
returns an error instead of repeating the beginning of the project.

`writing.start` resumes the latest unfinished activity for its project/topic
scope. A completed activity is left intact; a later start request creates a
new activity. Replaying an activity's creation request returns that same activity.
An empty scope returns `null` without creating an activity or logging an error.

Draft answers are saved without returning the reference text. Comparing an
answer reveals the immutable source-backed reference for that prompt. Revealed
answers cannot be changed. The activity records answer and reveal state inside
an immutable prompt snapshot, and written practice does not create study
events, concept reviews, automatic grades, or generation jobs.

The public Convex operations are:

- `api.writing.getLatest({ projectId, topicId? })`
- `api.writing.start({ projectId, topicId?, requestId })`
- `api.writing.saveAnswer({ projectId, activityId, itemId, answer, reveal })`

Creation validates the project/topic scope and each contributing concept and
source. Reads stay inside the requested scope; saves require the activity and
item to belong to that project. References are omitted from responses until the
corresponding item has been revealed.

The browser route is `/projects/[projectId]/write`, with an optional `topicId`.
Project Study offers quick questions or written answers; topic menus offer the
same deliberate writing entry. Drafts require an explicit save. A reload resumes
the first unfinished prompt, while comparisons stay visible until Next is chosen.
The activity keeps global navigation hidden and presents each saved answer once.

Verification covered project-wide and topic starts, hidden references before
comparison, draft restoration after reload, resuming the next unfinished prompt,
and advancing from five prompts to the one remaining prompt. Changing a fixture
card after activity creation did not change its saved reference. Replayed starts
returned the same activity; cross-scope request reuse, cross-project saves, and
edits after reveal were rejected. Empty topics returned `null` without creating
records. Desktop and 390px browser views were inspected. The isolated project
and its 18 child records were backed up and removed; no study events or concept
reviews were created.
