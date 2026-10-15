> **Superseded in part.** The feed's content now comes from `practice.feed`;
> see [practice.md](practice.md). The UI behavior below still applies.

# Review feed

The `/review` route renders the server-backed learning feed. It is reached from
the Today panel above the Library, which is the start page (`/`). It requests up to
20 due or new cards from `GET /api/learning/feed`, which also returns project
and topic options for the filter dialog.

Explanation cards show their body immediately. Question cards keep their body
hidden until `POST /api/learning/answer` returns a scored result and feedback.
Single-choice and true/false cards submit on selection. Multiple-answer cards
submit when the learner chooses `Check answers`.

`Skip` records a passive event through `POST /api/learning/event` and advances
the feed without recording an incorrect answer. The feed fills the screen; the shared app navigation returns to the Library.

`Ask in chat` opens a new workspace chat with the selected card locked as
context. The first question is sent to `POST /api/chat` without an existing
chat ID, so it creates a new session that appears in the Chat history. The
saved workspace transcript keeps the card attached and available across
reloads. Older card-conversation links and native clients continue using the
legacy persisted card-chat flow.

The feed prefetches near the last three loaded cards and follows an opaque server cursor. It keeps unique card IDs and combines filter metadata across pages. Empty eligible pages have a three-page automatic bound before `Load more` is offered. Filter changes cancel older requests, and continuation errors remain retryable without removing loaded cards.
