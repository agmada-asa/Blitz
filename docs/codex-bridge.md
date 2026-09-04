# Codex app-server bridge

`lib/server/codex-app-server.ts` is a bounded, server-only transport foundation
for Blitz's local Codex integration. It starts `codex app-server` over stdio,
performs the required `initialize` request followed by the `initialized`
notification, correlates JSON-RPC responses by request ID, and forwards
server notifications for streamed UI or job consumers.

The bridge requires an absolute `workspaceDirectory` for every connection and
passes it as the process working directory. The caller owns the policy that the
path is a Blitz-owned workspace. There is no implicit current-directory
fallback. The process inherits the local environment so Codex can use its
existing subscription login; this module does not read, print, or persist
authentication tokens.

The current public surface is intentionally small:

- `CodexAppServerClient.connect(options)` starts a connection and completes the
  handshake.
- `startThread({ model?, ephemeral?, approvalPolicy?, sandbox? })` creates a
  thread.
- `resumeThread(threadId, { approvalPolicy?, sandbox? })` reopens a stored
  thread.
- `startTurn(threadId, { text, model?, effort? })` starts a text turn.
- `interruptTurn(threadId, turnId)` requests cancellation.
- `onEvent(listener)` receives notifications, server requests, process errors,
  and process closure events.
- `close()` ends the child process and rejects unanswered calls.

Inbound lines, outbound messages, and concurrent requests are bounded. A
malformed line, oversized line, request timeout, child error, or child exit
rejects pending calls and terminates the connection. Approval requests are
always surfaced as `server-request` events. Until Blitz supplies a user-facing
approval flow, command and file-change requests receive `decline`, and
additional-permission requests receive an empty permission grant. A caller can
provide `approvalHandler` to make an explicit decision; handler failures fall
back to the same safe denial.

Thread creation and resume explicitly use `approvalPolicy: "on-request"` and
`sandbox: "read-only"` by default. Callers must opt into other verified
protocol values such as `workspace-write` when a later Blitz job requires them.

This is a transport foundation, not full Codex feature parity. It does not yet
implement tool execution, user-input elicitation, dynamic tools, thread
listing, reconnection, or persistence of Blitz-side chat records. Those belong
in the source and chat jobs after this boundary is reviewed.

The protocol was checked against the installed `codex-cli 0.153.0` using
`codex app-server --help` and its generated v2 JSON Schema. The tests use an
injectable in-memory child and never start a live Codex turn.

Reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Codex authentication](https://learn.chatgpt.com/docs/auth).
