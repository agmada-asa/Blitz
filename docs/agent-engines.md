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
- `startThread({ model?, ephemeral?, approvalPolicy?, sandbox?, dynamicTools? })`
  creates a thread. Dynamic tools require `experimentalApi: true` during the
  connection handshake.
- `resumeThread(threadId, { approvalPolicy?, sandbox? })` reopens a stored
  thread.
- `startTurn(threadId, { text, model?, effort? })` starts a text turn.
- `interruptTurn(threadId, turnId)` requests cancellation.
- `onEvent(listener)` receives notifications, server requests, process errors,
  and process closure events.
- `close()` ends the child process and rejects unanswered calls.

Inbound lines, outbound messages, and concurrent requests are bounded. A
malformed line, oversized line, request timeout, child error, or child exit
rejects pending calls and terminates the connection. Approval, Codex user-input,
app-owned dynamic tool, and MCP elicitation requests are surfaced as
`server-request` events. A caller
can provide `requestHandler` to return the protocol response after Blitz has
shown the request in its composer; the older `approvalHandler` remains
available for approval-only callers. Missing handlers and handler failures fall
back to safe denial, an empty answer map, a failed dynamic tool result, or MCP
cancellation.

Thread creation and resume explicitly use `approvalPolicy: "on-request"` and
`sandbox: "read-only"` by default. Callers must opt into other verified
protocol values such as `workspace-write` when a later Blitz job requires them.

This is a transport foundation, not full Codex feature parity. It supports
bounded application-provided function tools, but does not implement arbitrary
tool execution, thread listing, reconnection, or persistence of Blitz-side chat
records. Those belong in the source and chat jobs after this boundary is
reviewed.

The protocol was checked against the installed `codex-cli 0.153.4` using
`codex app-server --help` and its generated v2 JSON Schema. The tests use an
injectable in-memory child and never start a live Codex turn.

Reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Codex authentication](https://learn.chatgpt.com/docs/auth).
