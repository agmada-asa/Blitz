# Lesson updates

A Teach lesson is a live conversation, so files added to a unit after its outline was planned aren't taught on their own. A lesson update works out what the new files change, queues only those sections, and keeps everything the learner has already done.

## Starting one

`teachNewSources` (`lib/teach-updates.ts`) compares a unit's sources with the ones its lesson was planned from, and `units` returns the difference with the Teach session. When new ones have arrived, `TeachUpdateNotice` (`components/learn/teach-update-notice.tsx`) shows a notice in the header with **Update lesson**, then the update's progress, or its error with **Try again**. The MCP server's `update_unit` tool starts the same thing (see [the MCP server](../mcp/README.md)).

All of them call `POST /api/teach/update` (`lib/client/teach-update.ts` from the browser). The route starts the update in the background and returns; the run's state is saved on the Teach session, so callers follow it through Convex instead of holding a request open.

## How it runs

`convex/teachUpdates.ts` runs it in stages:

1. **`begin`** claims the lesson with a 10 minute lease (`TEACH_UPDATE_LEASE_MS`), so only one update runs at a time.
2. **`runContext`** gives the server the outline, plan, progress and up to 40 new sources, with up to 200,000 characters of each.
3. `lib/server/teach-update.ts` asks the provider, in a one-off turn outside the lesson's conversation, what the new files change. The prompt and reply schema are in `lib/teach-update-prompt.ts`, with the new files fenced between `NEW FILES BEGIN` and `NEW FILES END`. The turn has 9 minutes. If the lesson's provider is at a usage or rate limit, `teach-update-fallback.ts` moves the turn to the next signed-in provider, since the turn doesn't need the lesson's history.
4. **`apply`** merges the checked reply, or **`fail`** saves why it failed.

The reply marks each current section `unchanged`, `updated` (the files add examinable content or correct it) or `added` (a new topic no section covers), with concepts and a short note for each change, and a one-sentence summary for the learner.

## The merge

`mergeTeachUpdate` only trusts the reply for what it adds:

- Every existing section stays, in order, with its id, progress and earlier replies, even if the reply leaves it out.
- A section already taught keeps its title and only gains concepts, so earlier replies still make sense.
- Added sections go after the section they followed in the reply, each with a fresh id. The outline holds at most 16 sections (`MAX_UPDATED_TEACH_SECTIONS`); added sections that don't fit are reported as dropped.
- Taught sections the files change are queued to be taught again, with the note passed to the tutor.

Messages, quiz answers, the side chat and progress already earned are never touched. Each update is kept as a record (up to 20) and shown in the lesson as a divider, and replies it affects are labelled `updated`, `added` or `superseded`.

## Afterwards

Once a lesson has been updated, "next in the outline" is no longer enough. `nextTeachTarget` decides what `Next section` teaches: changed sections first, along with added sections the learner has already passed, then the next untaught section, skipping any the pre-check marked as known. `teachUpdateInstruction` turns the learner's message into an explicit instruction naming that section, so the tutor doesn't have to work it out.
