# Codex text turns and legacy card chat

The web app asks about cards in workspace chat (`docs/workspace-chat.md`). This
page covers the shared Codex text-turn runner that grew out of card chat, and
the saved card conversations that older chat links still open.

## Codex text turns

`lib/server/card-chat.ts` runs one bounded text turn through the local Codex
app-server:
`runCodexTextTurn({ workspaceDirectory, prompt, model?, effort?, ephemeral?, threadId?, signal?, timeoutMs? })`.
It requires an explicit absolute `workspaceDirectory`, starts or resumes the
supplied persistent thread, starts one text turn, streams typed `text-delta`,
`activity`, `completed`, and `error` events, and returns the server-issued
`threadId` and `turnId` only after `turn/completed` reports
`status: "completed"`. Optional `model` and `effort` overrides fall back to the
local Codex configuration. Its event, result, and `CardChatError` types are
shared by every provider adapter, so they keep their original names.

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
threads; conversations may keep their server-issued thread ID for resume.

The event shapes are based on the installed `codex-cli 0.153.0` v2 schema:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Saved card conversations

The `/api/learning/chat` routes and their Convex enqueue and retry functions were removed with the Android app. Conversation rows stay in the schema, and `conversations.getAttachment` still resolves the card for older `/chat` links. No worker answers card questions any more, so nothing writes new ones.

Provider turns use `BLITZ_CODEX_WORKSPACE` or `~/.local/share/blitz/codex-workspace`, an explicitly created directory outside the repository. `defaultChatWorkspaceDirectory` and `ensureChatWorkspaceDirectory` in `lib/server/research-worker.ts` resolve and create it for the research worker.

## Streaming and Markdown

`lib/server/chat-progress.ts` coalesces assistant fragments at 250 ms intervals, keeps at most one persistence request in flight, and drains writes before completion or failure. Workspace chat uses it to save streamed replies.

The web renderer uses the Marked parser and link validation in `lib/markdown.ts`. React renderers support headings, emphasis, nested lists, task lists, quotes, links, code, and GFM tables, including unfinished streaming fences. Raw HTML is displayed as text. Images display their alt text without remote fetching. Only explicit HTTP, HTTPS, and mailto links can open. Tables and code scroll horizontally inside the reply. New text follows the reader only while they remain near the bottom.

Verification includes byte-split Unicode, reconnect and cancellation tests, coalesced writes, unfinished Markdown, safe links, and a live local HTTP stream through progress and terminal mutations. Desktop and 390 px web layouts were visually checked.
