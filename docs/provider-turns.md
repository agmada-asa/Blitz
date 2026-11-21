# Provider text turns

Every model call in Blitz (Teach, chat, question banks, exams, research, lesson updates, podcasts) is one text turn run by `runProviderTextTurn` in `lib/server/providers/run-text-turn.ts`. The providers themselves are covered in [providers through agent-engines](agent-engines.md); this page covers the turn.

## A turn

A turn needs an explicit absolute `workspaceDirectory`. It starts or resumes the given thread and streams typed events: `turn-started`, `text-delta`, `thought-delta`, `activity`, `completed` and `error`. It returns the thread and turn IDs only after the runtime reports the turn complete. The event, result and `CardChatError` types live in `lib/server/card-chat.ts`; they kept their names from the first feature that used them.

- Streamed reply text is capped at 250,000 characters.
- A completed turn with no reply text is an error, so an empty answer is never treated as success.
- An abort signal or a timeout interrupts the turn, closes the runtime and emits one typed error. The default deadline is 60 seconds (`DEFAULT_CARD_CHAT_TIMEOUT_MS`); chat turns use ten minutes, and other callers set their own.
- Compacting a thread (`compactProviderThread`) has a five minute default.

Background work such as research planning uses ephemeral threads. Chats and Teach keep their thread ID so the next turn resumes it.

## Working folders

Chat turns run in a folder of their own, `<BLITZ_CODEX_WORKSPACE>/<chatId>`, which defaults to `~/.local/share/blitz/codex-workspace/<chatId>` and sits outside the repository (`chatWorkspaceDirectory` in `lib/server/chat-turn/attachments.ts`). Attached files are copied into its `attachments/` folder. A chat working in a project uses the project folder instead, and Teach uses the unit's project folder read-only. The research worker uses the shared folder itself (`defaultChatWorkspaceDirectory` in `lib/server/research-worker.ts`).

## Saving a streamed reply

`createChatProgress` (`lib/server/chat-progress.ts`) collects reply and reasoning fragments and saves at most four snapshots a second, in order, then drains any pending write before the final one. Workspace chat and Teach use it, so a reload shows the reply as far as it had got.

## Older card conversations

Card chats used to have their own routes and tables. Those are gone; asking about a card now opens a workspace chat with the card attached (see [workspace chat](workspace-chat.md)). `conversations.getAttachment` still resolves the card for old `/chat` links, which open as a new chat about that card.
