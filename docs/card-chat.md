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
No card-chat persistence or UI behavior is included here. Tests inject an
in-memory transport and never start a live model turn.

A separate local smoke check completed a real ephemeral Luna turn through the
installed app-server and returned the requested text. Generation uses ephemeral
threads; card conversations may keep their server-issued thread ID for resume.

The event shapes are based on the installed `codex-cli 0.153.0` v2 schema:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
