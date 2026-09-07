# Workspace chat

The Chat tab starts a general Codex conversation inside a project without
requiring a study card. A learner can attach up to eight context items. Supported context includes
study cards, Blitz projects, public links, PDFs, Markdown, plain text, and
PowerPoint files.

`components/chat/chat-workspace.tsx` extracts selected files in the browser and
uses the existing protected source-fetch route for public links. It sends only
new attachments with each message. A card opened from the learning feed is a
locked pending attachment. Its first question always starts a new workspace
chat, even if another chat is currently selected. Card actions may provide an
unsent, focused prompt in the composer; the learner reviews or edits it before
sending. The card's project becomes the owning and writable project
automatically. The empty-chat heading and the composer's project control both
show that project. Context chips sit above the message field. Once an
attachment enters the Codex thread, its chip stays visible because removing it
cannot remove content from the thread history.
`New chat` opens a project picker before clearing the active conversation. A
learner can choose an existing project or create one in the picker. Project and
card entry points use their known project. The selected project owns the saved
chat and is attached as its initial context. Older projectless chats remain
readable. Opening the Chat tab itself does not open the picker.

Each saved message has a copy action. Editing a user message creates a branch
immediately before that message, sends the revision there, and leaves the
original transcript unchanged. Branching an assistant response copies the
transcript and attachments through that response into a new chat. The next
message rebuilds a fresh Codex session from that branch so it keeps the selected
history without reusing later turns from the original conversation.

While a reply is streaming, the send control and the latest assistant message
offer `Pause`. Pausing closes the browser request and keeps any generated text
as an interrupted response. `Continue response` resumes into the same message;
if no text arrived before the pause, the recovery action is labeled `Retry
response`. A continuation cannot add a new user message or attachment.

`app/api/chat/route.ts` validates a bounded request, loads selected project
context through `convex/chatContext.ts`, resolves a card and its prepared source
snapshot when present, and starts or resumes a local Codex thread. A card
reference cannot be sent with an existing `chatId`, so card chats never inherit
another workspace session. `convex/workspaceChats.ts` requires and validates an
owning project before it creates a chat, stores each user message before Codex
starts, records the card attachment, coalesces streaming reply
snapshots, and saves the Codex thread and turn IDs as soon as Codex accepts the
turn. If a chat predates that guarantee or its saved thread cannot be resumed,
Blitz passes a bounded copy of the saved transcript and attachments with the
next message. A thread that cannot be resumed is replaced after that failed
resume attempt. The route streams newline-delimited lifecycle events to the
open browser while Convex keeps the transcript available across reloads. Codex
runs in the shared Blitz chat workspace with a read-only sandbox. Workspace
turns have a ten-minute deadline so source lookups are not cut off by the
shorter card-chat limit.

Every attachment is wrapped in an explicit untrusted-context boundary before
it reaches Codex. The server caps project count, source count, request bytes,
attachment text, and total project text. Public URLs still pass through the
existing DNS-pinned source ingestion path.

The sidebar lists the 60 most recently active workspace chats, including chats
started from cards. Selecting a row opens its saved transcript through a stable
`chatId` URL. Older card conversations opened with `projectId` and `itemId`
continue to use their existing flow.
