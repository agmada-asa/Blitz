# Learning persistence

The new learning tables sit beside the prototype `cards` and `attempts`
tables. They give generated material stable source references and keep raw
study events separate from the review summary derived from them.

`topics` belong to a project and may point to a parent topic in that same
project. `concepts` belong to a project, may belong to a topic, and keep the
source IDs that support the concept. Every `learningItems` row belongs to one
concept and project and must cite at least one source attached to that
concept. Item insertion accepts a bounded batch of up to 100 items.

Learning items support `explain`, `single-choice`, `multiple-answer`, and
`true-false`. Choice options and the stored correct answer fields are kept on
the server. `listLearningFeedCandidates` omits correct answer fields before
returning feed data to a client.

## Event rules

`recordAnswerEvent` receives an item ID, timestamp, client idempotency key, and
the user's answer. It loads the stored item and calls the shared evaluator in
`lib/learning` on the server. The client never supplies correctness, counts,
or a due date. Invalid answers return an `invalid` result and create no event,
so they do not become wrong-answer evidence. The server stores the scored
outcome on the event, making later replay independent of item edits.

`recordPassiveEvent` accepts only `skip` and `exposure`. It records those events
for analytics and sync, but never creates or changes a concept review summary.
The two event mutations scope idempotency keys to a project and reject reuse
with a different item, event type, timestamp, or answer. Reordered
multiple-answer arrays represent the same payload.

When a scored answer is recorded, the server rebuilds that concept's summary
from the stored outcomes of all answer events sorted by `occurredAt`,
`receivedAt`, and event ID. This ordering handles offline answers that arrive
out of order without treating arrival order as learning order. The summary is
then written to `conceptReviews` for fast feed queries. The rebuild uses the
same bounded heuristic as the portable learning core, so it remains
inspectable rather than claiming to predict mastery.

`listLearningFeedCandidates` returns a bounded page with `items`, `isDone`, and
`continueCursor`. Pass Convex `paginationOpts` to continue scanning a large
project. The query scans no more than the requested result limit, capped at
100 items, and may return fewer matches when topic filters exclude rows.
The cursor always points after exactly the scanned rows, so no matching
items are skipped between pages. `isDone` reflects database exhaustion.

Feed candidates include an explanation body for `explain` items. Project
walkthrough cards also receive the optional source-grounded `deepExplanation`
stored on explain items; the card keeps the concise body on its front and
reveals the longer lesson on its back. Question item bodies remain answer
feedback, so a question's explanation is not shown before the learner answers.
After a valid answer, `recordAnswerEvent` returns the server-scored outcome,
portable review state, and feedback containing the stored explanation and
correct answer fields. Retries return the same shape.
