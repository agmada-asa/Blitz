# Provider text turns and legacy card chat

The web app asks about cards in workspace chat (`docs/workspace-chat.md`). This
page covers the shared provider text-turn runner that grew out of card chat, and
the saved card conversations that older chat links still open.

## Provider text turns

`runProviderTextTurn` in `lib/server/providers/run-text-turn.ts` runs one bounded text turn on the selected provider. It requires an explicit absolute `workspaceDirectory`, starts or resumes the supplied thread, streams typed `turn-started`, `text-delta`, `thought-delta`, `activity`, `completed`, and `error` events, and returns the thread and turn IDs only after the runtime reports the turn completed. Codex and Claude Code run through agent-engines (see [Codex and Claude Code through agent-engines](agent-engines.md)); OpenCode runs through ACP. The event, result, and `CardChatError` types in `lib/server/card-chat.ts` are shared by every provider, so they keep their original card chat names.

Streamed assistant text is capped at 250,000 characters. A completed turn with no assistant text is reported as an error so callers cannot treat an empty response as a successful answer. Abort signals and wall-clock timeouts interrupt the running turn, close the runtime, and emit one typed error.

Generation uses ephemeral threads; conversations keep their thread ID for resume.

## Saved card conversations

The `/api/learning/chat` routes and their Convex enqueue and retry functions were removed with the Android app. Conversation rows stay in the schema, and `conversations.getAttachment` still resolves the card for older `/chat` links. No worker answers card questions any more, so nothing writes new ones.

Provider turns use `BLITZ_CODEX_WORKSPACE` or `~/.local/share/blitz/codex-workspace`, an explicitly created directory outside the repository. `defaultChatWorkspaceDirectory` and `ensureChatWorkspaceDirectory` in `lib/server/research-worker.ts` resolve and create it for the research worker.

## Streaming and Markdown

`lib/server/chat-progress.ts` coalesces assistant fragments at 250 ms intervals, keeps at most one persistence request in flight, and drains writes before completion or failure. Workspace chat uses it to save streamed replies.

The web renderer uses the Marked parser and link validation in `lib/markdown.ts`. React renderers support headings, emphasis, nested lists, task lists, quotes, links, code, and GFM tables, including unfinished streaming fences. Raw HTML is displayed as text. Images display their alt text without remote fetching. Only explicit HTTP, HTTPS, and mailto links can open. Tables and code scroll horizontally inside the reply. New text follows the reader only while they remain near the bottom.

Verification includes byte-split Unicode, reconnect and cancellation tests, coalesced writes, unfinished Markdown, safe links, and a live local HTTP stream through progress and terminal mutations. Desktop and 390 px web layouts were visually checked.
