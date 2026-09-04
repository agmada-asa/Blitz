# Shared learning HTTP API

The browser and native clients use the same small HTTP boundary under
`/api/learning`. The contracts live in `lib/learning/client-contracts.ts` so
clients do not need to import Convex types or know about the local personal-app
deployment.

`GET /api/learning/feed` accepts optional `projectId`, `topicId`, and `limit`
(1–30), plus the opaque `cursor` returned by a prior response. It returns
`FeedResponse` with mixed due or new cards plus project and topic filter
options. `continueCursor` is present while more bounded pages remain;
`isDone` is true only when the scan is exhausted. Feed cards expose actual
source filenames and source IDs, but never expose correct answer keys.
Explanations include `body`; question cards withhold their answer explanation
until the answer endpoint responds.

`POST /api/learning/answer` accepts `AnswerRequest`. Convex evaluates the
answer against the stored learning item, records only valid scored events, and
returns `AnswerResponse` with status and server-owned feedback or correct keys.
`POST /api/learning/event` accepts `EventRequest` for `skip` or `exposure`.
These passive events do not update concept review state.

Request bodies are capped at 32,000 bytes. Invalid JSON or payloads return 400.
The server adapter checks `BLITZ_CONVEX_URL`, then `CONVEX_URL`, then the
browser-facing `NEXT_PUBLIC_CONVEX_URL`. Missing Convex configuration or
backend failures return a generic 503;
raw Convex errors and source content are never sent over the HTTP boundary.
The current app is a personal local deployment and this API does not claim to
provide public SaaS authentication or multi-user isolation.
