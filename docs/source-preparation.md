# Source preparation queue

`convex/preparation.ts` provides a small queue for the local Mac worker. The
queue only prepares an existing source. `enqueue` snapshots its extracted text,
filename, and kind, so a worker can finish the same input even if a future
import changes. Snapshots are bounded at 120,000 characters, matching the
current source limit.

Generic uploads cover all factual material in the snapshot. Research imports
copy the approved proposal's bounded (3,000-character) `learningScope` into the preparation job;
the worker uses that scope as a filter, so chunks outside the approved scope
produce an explicit `SKIPPED:` batch instead of unrelated concepts. Generated
questions are written as standalone prompts and do not refer to the source or
chunk as context. Each claim also includes a bounded, title-ordered list of
existing project topics. The prompt asks generation to reuse a listed title
when it fits and limit new topics to new subjects. Preparation never renames
or merges existing topics.

The worker flow is:

1. Call `enqueue({ projectId, sourceId })`. Repeating the call returns the
   existing job for that project and source.
2. Call `claimNext({ workerId, leaseToken })`. The oldest queued job, or a job
   whose lease expired, is leased for five minutes. Repeating the call with the
   same live worker and token returns the same lease.
3. Split the returned source snapshot locally, generate one chunk at a time,
   and call `commitChunk` with the expected ordinal, stable chunk ID, total
   chunk count, and the validated generation batch.
4. Each commit clears its lease and requeues the remaining work. Claim again to
   continue from `nextChunk.ordinal`. A final chunk marks the job completed.

`commitChunk` validates the batch with the shared portable generation schema.
Every item must point to the current chunk ID. It then creates the batch's
topics, concepts, and source-linked learning items in one mutation and records
the chunk checkpoint. Learning items keep `sourceChunkId` and
`sourceChunkOrdinal` for precise attribution.

Matching topic titles within a project are reused. Matching concept titles in
the same topic are also reused, adding the current source to their references.
This keeps repeated chunks from splitting one concept's review history.

If a worker loses the response after a successful commit, repeating the same
commit for that ordinal and chunk ID returns the existing progress without
creating duplicate content. A different chunk ID, total count, ordinal, or
lease token is rejected. A stale worker cannot commit after another worker has
claimed the expired lease.

Already-committed checkpoints can be read back with a previous token. They do
not write anything; new commits always require the current live lease.

`failJob` records a bounded safe error and clears the lease. The local worker
classifies failures as invalid model output, unreadable source, interruption,
timeout, transport, or save failure, then stores fixed recovery copy rather
than model or source details. `retry` puts a failed or expired job back in the
queue without discarding completed chunk checkpoints. There is no multi-user
authorization layer in this first personal deployment, and the queue does not
expose agent execution or network access.
The local worker owns source splitting and generation timeouts; the queue only
stores snapshots, validates batches, and persists bounded results.

Progress includes `generatedItemCount` for new jobs. It starts at zero and is
advanced with each committed chunk in the same idempotent checkpoint mutation.
Older partial jobs return `null` because their earlier item count is unknown.
A completed job with zero generated items marks its source failed with “No study
content” guidance, so the interface does not present an empty feed as ready and
does not offer a retry loop for the same unreadable input.

## Running the Mac worker

Run `npm run worker` alongside the local Convex and web servers. It reads the
existing `.env.local`, claims one chunk at a time, generates through the local
Codex app-server, and commits only validated output. `npm run worker -- --once`
processes one available chunk and exits. `BLITZ_CONVEX_URL` overrides the data
endpoint. Until a model setting is saved, `BLITZ_CODEX_MODEL` overrides the
default Luna model. Saved card-generation settings take precedence; see
`docs/ai-model-settings.md`.

Each generation uses a private temporary directory and an ephemeral Codex
thread with hosted web search disabled. Research planning retains its separate live-search configuration. The worker removes that directory after the turn. It never changes the
repository through model tools. Interrupting the worker preserves committed
chunks, and a failed job can be retried from its saved ordinal. The current
source snapshot limit is 120,000 characters per part. Larger uploads are split
before queueing, as described in `docs/source-splitting.md`.

Generation asks multiple-answer questions to include at least one incorrect
option, so a learner must distinguish the complete answer set. If a model
response fails the strict bounded validator, the generation boundary makes one
repair call containing the original source prompt and a short validation
message. It accepts one strict JSON markdown fence around an otherwise valid
response, but rejects prose wrappers. It never retries transport errors or
cancellation, never persists an invalid batch, and never makes more than that
one repair attempt.
