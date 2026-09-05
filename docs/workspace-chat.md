# Workspace chat

The Chat tab starts a general Codex conversation without requiring a study
card. A learner can attach up to eight context items. Supported context includes
Blitz projects, public links, PDFs, Markdown, plain text, and PowerPoint files.

`components/chat/chat-workspace.tsx` extracts selected files in the browser and
uses the existing protected source-fetch route for public links. It sends only
new attachments with each message. Once an attachment enters the Codex thread,
the interface keeps it visible as `In chat` because removing the chip cannot
remove content from the thread history. `New chat` opens an empty composer and
leaves the saved conversation in the history rail.

`app/api/chat/route.ts` validates a bounded request, loads selected project
context through `convex/chatContext.ts`, and starts or resumes a local Codex
thread. `convex/workspaceChats.ts` stores each user message before Codex starts,
coalesces streaming reply snapshots, and saves the Codex thread ID on
completion. The route streams newline-delimited lifecycle events to the open
browser while Convex keeps the transcript available across reloads. Codex runs
in the shared Blitz chat workspace with a read-only sandbox.

Every attachment is wrapped in an explicit untrusted-context boundary before
it reaches Codex. The server caps project count, source count, request bytes,
attachment text, and total project text. Public URLs still pass through the
existing DNS-pinned source ingestion path.

The sidebar lists the 60 most recently active general chats. Selecting a row
opens its saved transcript through a stable `chatId` URL. Card conversations
opened with `projectId` and `itemId` continue to use their existing flow.
