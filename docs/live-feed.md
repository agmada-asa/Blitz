# Live home feed

The root route (`/`) renders the server-backed learning feed. It requests up to
20 due or new cards from `GET /api/learning/feed`, which also returns project
and topic options for the filter dialog.

Explanation cards show their body immediately. Question cards keep their body
hidden until `POST /api/learning/answer` returns a scored result and feedback.
Single-choice and true/false cards submit on selection. Multiple-answer cards
submit when the learner chooses `Check answers`.

`Skip` records a passive event through `POST /api/learning/event` and advances
the feed without recording an incorrect answer. The home feed has no persistent
navigation; `Library` is the overlay route to `/library`, which owns the
project-grid flow.

Chat attaches the selected card and sends the learner's question to
`POST /api/learning/chat`. The dialog polls the conversation while open, keeps
queued or running questions visible, and shows the worker's reply when one is
available. Failed sends keep the question and offer `Retry`; repeated submits
reuse the same client message ID so the queue stays idempotent. The interface
does not fabricate a reply while the worker is pending or unavailable.

The feed prefetches near the last three loaded cards and follows an opaque server cursor. It keeps unique card IDs and combines filter metadata across pages. Empty eligible pages have a three-page automatic bound before `Load more` is offered. Filter changes cancel older requests, and continuation errors remain retryable without removing loaded cards.
