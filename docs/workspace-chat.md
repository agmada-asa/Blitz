# Workspace chat

The Chat tab starts a general Codex conversation without requiring a study
card. A learner can attach up to eight context items. Supported context includes
Blitz projects, public links, PDFs, Markdown, plain text, and PowerPoint files.

`components/chat/chat-workspace.tsx` extracts selected files in the browser and
uses the existing protected source-fetch route for public links. It sends only
new attachments with each message. Once an attachment enters the Codex thread,
the interface keeps it visible as `In chat` because removing the chip cannot
remove content from the thread history. `New chat` clears the transcript,
attachments, and Codex thread ID.

`app/api/chat/route.ts` validates a bounded request, loads selected project
context through `convex/chatContext.ts`, and starts or resumes a local Codex
thread. The route streams newline-delimited text deltas and a final thread ID.
Codex runs in the shared Blitz chat workspace with a read-only sandbox and the
same model configuration as card chat.

Every attachment is wrapped in an explicit untrusted-context boundary before
it reaches Codex. The server caps project count, source count, request bytes,
attachment text, and total project text. Public URLs still pass through the
existing DNS-pinned source ingestion path.

The browser owns the visible general-chat transcript for now. Reloading the
page starts a blank view, while card conversations opened with `projectId` and
`itemId` continue to use their existing persisted flow.
