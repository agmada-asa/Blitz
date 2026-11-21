# Learning HTTP API

Study screens talk to the learning core through a small HTTP boundary under `/api/learning`, implemented in `lib/server/learning-api.ts`. The request and response types live in `lib/learning/client-contracts.ts`, so a client doesn't need Convex types.

| Route | What it does |
| --- | --- |
| `GET /api/learning/feed` | A page of the Review feed |
| `GET /api/learning/session` | A Study or Test deck; see [study sessions](study-sessions.md) |
| `POST /api/learning/answer` | Scores and saves an answer |
| `POST /api/learning/recall` | Reveals a recall card's answer, or saves a self-graded recall |
| `POST /api/learning/event` | Saves a `skip` or `exposure` |

## Feed

`GET /api/learning/feed` takes optional `projectId`, `limit` (1–30, default 20) and the `cursor` from the previous page, and serves `practice.feed` (see [practice](practice.md#review-feed)). The cursor is an opaque list of up to 300 item IDs already shown, so pages don't repeat; a malformed cursor returns 400. The feed never ends, so `isDone` is true only when a page comes back empty. `topicId` is accepted but currently ignored, and the returned topic list is always empty.

Feed cards carry the unit title as `sourceLabel` and the source IDs, never an answer key. A question's explanation arrives only in the answer response.

## Answers and events

`POST /api/learning/answer` takes an `AnswerRequest`. Convex scores it against the stored item, saves only valid scored answers, and returns the outcome with feedback and the correct answer. `POST /api/learning/recall` either reveals the answer without saving anything, or saves the learner's "knew it" or "didn't" as a recall answer. `POST /api/learning/event` saves `skip` or `exposure`, which never change a review. The rules are in [learning core](learning-core.md#saving-answers).

## Errors and configuration

Bodies over 32,000 bytes, invalid JSON and invalid payloads return 400. The routes reach Convex through `serverConvexClient` (`lib/server/convex.ts`), which checks `BLITZ_CONVEX_URL`, then `NEXT_PUBLIC_CONVEX_URL`, then `CONVEX_URL`. A missing configuration or a backend failure returns a generic 503; raw Convex errors and source text never cross the boundary.

Blitz is a personal local app, and this API has no authentication or multi-user isolation.
