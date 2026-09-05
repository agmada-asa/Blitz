# Card chat

`lib/server/card-chat.ts` runs one learner-authored question against a
selected Blitz card and its relevant source context through the local Codex
app-server. It requires an explicit absolute `workspaceDirectory`, starts or
resumes the supplied persistent thread, starts one text turn, streams typed
`text-delta`, `activity`, `completed`, and `error` events, and returns the
server-issued `threadId` and `turnId` only after `turn/completed` reports
`status: "completed"`.

Server jobs that already own a bounded prompt can call the same lifecycle via
`runCodexTextTurn({ workspaceDirectory, prompt, model?, effort?, ephemeral?, threadId?, signal?, timeoutMs? })`.
`runCardChat` is the card-specific wrapper that builds the attachment first.
Both helpers accept optional `model` and `effort` overrides; omitted values
preserve the local Codex configuration.

The prompt treats card and source content as untrusted study data. The caller
must provide a non-empty question; the service never invents a generic
explanation. Source context is capped at 12,000 characters and visibly marked
when truncated. Card fields and the question are bounded before any transport
is started.

Streamed assistant text and raced notifications are capped at 250,000
characters. A completed turn with no assistant text is reported as an error so
callers cannot treat an empty response as a successful answer.

Thread creation and resume use `approvalPolicy: "on-request"` and
`sandbox: "read-only"`. The underlying transport declines approval requests
until Blitz wires a user-facing approval flow. Abort signals and wall-clock
timeouts interrupt an active turn when its ID is known, close the transport,
and emit one typed error. Late transport creation is also closed if
cancellation wins the race.

The `activity` event retains each original app-server notification so later
tool and richer activity support can be added without changing this boundary.
The transport layer owns no persistence or UI. Tests inject an
in-memory transport and never start a live model turn.

A separate local smoke check completed a real ephemeral Luna turn through the
installed app-server and returned the requested text. Generation uses ephemeral
threads; card conversations may keep their server-issued thread ID for resume.

The event shapes are based on the installed `codex-cli 0.153.0` v2 schema:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Persistent card conversations

`POST /api/learning/chat` accepts only `projectId`, `itemId`, `clientMessageId`, and the learner's `question`. It creates or resumes one conversation per project and learning item, and treats a repeated client message id as an idempotent retry. The `202` response includes `conversationId`, `messageId`, `status`, `alreadyQueued`, and the full safe message record. `GET /api/learning/chat?projectId=...&itemId=...` returns message status, questions, replies, errors, and the saved conversation status. It never returns source text.

The local `scripts/chat-worker.ts` process claims queued messages with a bounded lease. It loads the selected learning item and its prepared source chunk, reconstructs that chunk from the preparation snapshot, then calls `runCardChat` with the saved Codex thread when available. A successful turn stores the thread id, turn id, and non-empty reply atomically. A failed turn keeps its question and history; retry is an explicit `convex.conversations.retry` mutation.

For HTTP clients, `POST /api/learning/chat/retry` takes `projectId`, `itemId`, and the failed `messageId`; it deliberately requeues that existing record and never creates a duplicate question.

The worker uses `BLITZ_CODEX_WORKSPACE` or `~/.local/share/blitz/codex-workspace`, an explicitly created directory outside the repository. `BLITZ_CODEX_MODEL` defaults to `gpt-5.6-luna`; sandbox is read-only and approval requests remain declined until an approval UI is wired. The queue allows later questions to wait behind an active turn and recovers expired leases, so the web request can succeed while the Mac worker is offline.

The launcher can use `defaultChatWorkspaceDirectory`, `ensureChatWorkspaceDirectory`, `runChatWorkerStep`, and `runChatWorker` from `lib/server/chat-worker.ts`. Activity events stay inside the worker; the HTTP stream exposes persisted conversation snapshots.

Start the local chat process with `npm run worker:chat` beside `npm run worker` and the development servers. Both workers load `.env.local` and prefer `BLITZ_CONVEX_URL` for a loopback connection.

## Streaming and Markdown

Both apps use `GET /api/learning/chat?projectId=...&itemId=...&stream=1` to receive newline-delimited JSON snapshots from a live Convex subscription. The plain GET remains available for older clients. Blank-line heartbeats arrive every ten seconds. Connections rotate after one minute; clients reconnect and receive current history without resubmitting questions. Closing chat cancels its subscription, not the worker. A silent connection times out after thirty seconds and retries with bounded backoff.

`lib/server/chat-progress.ts` coalesces assistant fragments at 250 ms intervals, keeps at most one persistence request in flight, and drains writes before completion or failure. `conversations.progress` requires the active, unexpired lease and bounds replies to 250,000 characters. Failed answers retain partial text alongside the error. Explicit retries and reclaimed leases clear that text before a fresh attempt. Completion replaces fragments with the authoritative final answer.

Web and Android share the Marked parser and link validation in `lib/markdown.ts`. React renderers support headings, emphasis, nested lists, task lists, quotes, links, code, and GFM tables, including unfinished streaming fences. Raw HTML is displayed as text. Images display their alt text without remote fetching. Only explicit HTTP, HTTPS, and mailto links can open. Tables and code scroll horizontally inside the reply. New text follows the reader only while they remain near the bottom.

Verification includes byte-split Unicode, reconnect and cancellation tests, coalesced writes, unfinished Markdown, safe links, and a live local HTTP stream through progress and terminal mutations. Desktop and 390 px web layouts were visually checked. Android type checks and a bundled APK build pass; native device rendering has not been visually verified for this change.
