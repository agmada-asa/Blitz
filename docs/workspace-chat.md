# Workspace chat

The Chat tab starts a general Codex conversation inside a project without
requiring a study card. A learner can attach up to eight context items. Supported context includes
study cards, Blitz projects, public links, and arbitrary files (with text previews for code/documents, descriptors for binaries, and automatic staging into the agent's working directory under `attachments/`).

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
`New chat` clears the active conversation and starts a standalone chat session. A
learner can also start a project-scoped chat from a project group in the chat
history sidebar, or attach projects and other material as context from the composer.
Projectless chats are fully supported and can be branched, renamed, pinned, or archived.
Opening the Chat tab itself presents a fresh conversation ready for any question.

Each saved message has a copy action. Editing a user message creates a branch
immediately before that message, sends the revision there, and leaves the
original transcript unchanged. Branching an assistant response copies the
transcript and attachments through that response into a new chat. On Codex and
Claude Code the branch's first message forks the original runtime thread
through the last kept reply (`forkSource` on the chat), so it keeps everything
the original had read, tool results included, without later turns. A branch
shares its source's working folder, because Claude Code keeps sessions per
folder; a Claude Code chat with a working project, and every OpenCode chat,
replays the bounded transcript into a fresh session instead, as does a fork that
fails (for example at a turn ID saved by an older runtime).

When a reply stops short because a tool was blocked, the model refused, or a
safety check held part of it back, the reply carries a short notice saying so
(`lib/turn-notices.ts`). Other runtime notices go to the server log only.

While a reply is streaming, the send control and the latest assistant message
offer `Pause`. Typing notes into the composer while streaming allows in-flight
hot steering: submitting these notes pauses the active turn and immediately
continues with the learner's guidance. Pausing closes the browser request and
keeps any generated text as an interrupted response. The composer docks to the
paused reply with the prompt `Add notes before continuing, or press Play to resume`.
The learner can click `Play` to resume generation as-is, or submit steering
notes to guide the continuation. `Continue response` directly on the assistant
message also resumes into the same message; if no text arrived before the pause,
the recovery action is labeled `Retry response`. A continuation cannot add new
context attachments. If the learner prefers to start a fresh turn instead of
continuing, they can dismiss the continuation dock.

When the provider asks for a decision or structured input, the active assistant
turn stores one short-lived request envelope. The composer shows the request in
a single panel anchored above the message field. It supports command, file,
permission, and native tool approvals, Codex questions, and supported MCP form
or URL handoffs. The panel stays available while the message field is paused,
and the response is posted to the existing approval endpoint so the provider
turn can continue. Reloading or switching back to a running chat restores the
same pending panel from the saved assistant message.

New Codex chat sessions also receive two Blitz-owned dynamic tools. One asks up
to three structured questions and the other creates an explicit confirmation
checkpoint when the user requests one that would not otherwise invoke a native
runtime approval. These tools work in the ordinary chat collaboration mode;
they do not depend on Codex's mode-gated built-in user-input tool. Command, file,
and permission operations continue to use native runtime approvals. Explicit
confirmation checkpoints remain available in every access mode because they do
not grant filesystem, command, or network access. Existing
chats refresh their provider context once when this tool set is first enabled,
replaying the bounded saved transcript into the replacement session.

`app/api/chat/route.ts` validates a bounded request, loads selected project
context through `convex/chatContext.ts`, resolves a card and its prepared source
snapshot when present, and starts or resumes a local Codex thread. A card
reference cannot be sent with an existing `chatId`, so card chats never inherit
another workspace session. `convex/workspaceChats.ts` creates and updates chats
with or without an owning project, stores each user message before Codex starts,
records any card or context attachments, coalesces streaming reply snapshots, and
saves the Codex thread and turn IDs as soon as Codex accepts the turn. If a chat predates that guarantee or its saved thread cannot be resumed,
Blitz passes a bounded copy of the saved transcript and attachments with the
next message. A thread that cannot be resumed is replaced after that failed
resume attempt. The route streams newline-delimited lifecycle events to the
open browser while Convex keeps the transcript available across reloads. Codex
runs in the shared Blitz chat workspace with a read-only sandbox. Workspace
turns have a ten-minute deadline so source lookups are not cut off by the
shorter card-chat limit.

When a turn fails, the chat shows recovery copy from `lastError`. The same
record keeps `lastErrorReason`, a stable category such as `turn-failed`,
`transport`, or `interrupted`, and `lastErrorDetail`, the underlying error
including the provider's own message. Neither is shown in chat; read them with
`npx convex run workspaceChats:get '{"chatId":"..."}'` to diagnose a failure
without the server log. Starting a new turn clears all three. When a project
chat finishes, Blitz refreshes the project's artifact list, skipping the
`Sources`, `.blitz`, `attachments`, and generated `Audio` folders. A failure
there is logged and never discards the finished reply.

Every attachment is wrapped in an explicit untrusted-context boundary before
it reaches Codex. The server caps project count, source count, request bytes,
attachment text, and total project text. Public URLs still pass through the
existing DNS-pinned source ingestion path.

Attached project and card sources are the primary evidence for a reply. When
they cannot resolve the question, are incomplete or outdated, or another tool
would materially improve the answer, interactive Codex chat may use an
available tool such as live web search. External findings must remain distinct
from attached source citations, and the selected access policy still governs
the provider's other tool actions.

The sidebar lists the 60 most recently active workspace chats, including chats
started from cards. Selecting a row opens its saved transcript through a stable
`chatId` URL. Older card conversations opened with `projectId` and `itemId`
continue to use their existing flow.
