# Workspace chat

The Chat tab (`components/chat/chat-workspace.tsx`) is a general conversation with the provider picked in its model picker: Codex, Claude Code, OpenCode or Antigravity. A chat can stand alone or belong to a module, and can work in a module's project folder. Teach sessions and Teach side chats are workspace chats too (see [Teach](teach.md)).

## Context

The composer attaches context as chips above the message field:

- **A study card**, opened from **Ask in chat** in the feed. It's locked to the message, its first question always starts a new chat, and the card's module becomes the chat's module.
- **Modules**: up to three, sharing 48,000 characters of material (`convex/chatContext.ts`).
- **Public links**, fetched through the same pinned route as `Add material`.
- **Files**: text and code are read into the message, images (up to 5 MB) go to the provider as images, and every file is saved as a chat document and copied into the turn's `attachments/` folder (see [chat citations](chat-citations.md#source-storage)).

Only new attachments are sent with each message. Once an attachment is in the provider's thread its chip stays, because removing it can't remove it from the thread. Every attachment is wrapped as untrusted context. The server caps the message (4,000 characters), attachment text (96,000 characters) and the whole request (140,000 bytes).

Attached material is the main evidence for a reply. When it can't answer the question, or a tool would clearly help, the provider may use what it has, such as live web search on Codex; outside findings are kept apart from source citations.

## Working project and access

The composer's project control picks a **working project**. Without one, a chat runs in its own folder outside the repository (see [provider text turns](provider-turns.md#working-folders)); with one, it runs in that project's folder, and **Plan first** runs the turn in the provider's plan mode (Codex and Claude Code), so the agent proposes a plan before it edits anything.

The model picker's **Access level** menu sets what the provider may do, with labels from each provider's own permission model (see [provider controls](../README.md#provider-controls)). On Codex, a chat is read-only by default, can write in the working project, or has full access. Teach turns are always read-only.

## Requests

When the provider asks for a decision or input, the reply saves one short-lived request and the composer shows it in a panel above the message field: command, file, permission and tool approvals, Codex questions, and supported MCP form or URL handoffs. Answers go to `POST /api/chat/approval`. Reloading or switching back restores the panel. Every decision covers one operation or turn; Blitz never saves a permanent rule.

New Codex chats also get two Blitz tools (`lib/server/agent-request.ts`): one asks up to three structured questions, and one creates a confirmation checkpoint when the learner wants to approve a step that wouldn't otherwise ask. They work in every access level because they grant nothing.

## Pausing and steering

While a reply streams, the send button and the reply offer **Pause** (`POST /api/chat/pause`). Pausing keeps what was written as an interrupted reply. Typing notes while it streams and sending them pauses the turn and carries on with that guidance. A paused reply docks the composer with `Add notes before continuing, or press Play to resume`; **Play** resumes as is, and notes steer the continuation. **Continue response** on the reply does the same, or **Retry response** if nothing arrived. A continuation can't add attachments.

## Branching and editing

Editing a user message branches the chat just before it and sends the edit there; the original stays as it was. Branching from a reply copies the transcript and attachments up to that reply into a new chat. On Codex and Claude Code the branch forks the original thread at that reply (`forkSource`), so it keeps everything the original had read; branches share the original's folder because Claude Code keeps sessions per folder. A Claude Code chat with a working project, every OpenCode and Antigravity chat, and any fork that fails replay the saved transcript into a new session instead.

## Providers and limits

The chat saves its own provider, model and reasoning (`workspaceChats.replySelection`), so later messages stay on it. When a reply stops at a provider's usage limit, the chat offers to move to another signed-in provider (`components/chat/provider-handoff-offer.tsx`, `workspaceChats.handOff`), which carries the conversation over with `handoffPrompt`.

A chat turn has ten minutes. A reply cut short by a blocked tool, a refusal or a safety check shows a short notice (`lib/turn-notices.ts`); other runtime notices go to the server log.

## Saving and failures

`app/api/chat/route.ts` saves the user's message before the provider starts, and the thread and turn IDs as soon as the provider accepts the turn. Streamed text is saved as it arrives, so the reply survives a reload. If the saved thread can't be resumed, the next message carries a bounded copy of the transcript (the latest 24 messages and 8 attachments) into a new session.

A failed turn shows recovery copy from `lastError`. The chat also keeps `lastErrorReason` (such as `turn-failed`, `transport`, `interrupted` or `usage-limit`) and `lastErrorDetail` with the provider's own message. Neither is shown; read them with `npx convex run workspaceChats:get '{"chatId":"..."}'`. A new turn clears all three.

When a chat with a working project finishes, Blitz refreshes the project's artifact list, skipping `Sources`, `attachments` and `Audio`. A failure there is logged and never loses the reply.

## The sidebar and chat menu

The sidebar lists the 60 most recently active chats, grouped by module, with a stable `chatId` URL for each. Chats can be renamed, pinned, archived and deleted; the worker's `threads` loop names new chats and deletes the provider threads of deleted ones. The chat menu's **Export chat** copies or downloads the chat as Markdown, with or without the agent's working notes and tool calls. Replies have copy and read-aloud actions.
