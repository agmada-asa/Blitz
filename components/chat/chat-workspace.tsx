"use client"

/** Owns persisted Codex chat selection, streaming, and mixed-context attachments. */

import {
  Attachment02Icon,
  BubbleChatIcon,
  File01Icon,
  Folder01Icon,
  Link02Icon,
  Menu01Icon,
  Sent02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useQuery } from "convex/react"
import Link from "next/link"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import {
  ChatHistory,
  type ChatHistoryItem,
} from "@/components/chat/chat-history"
import { ReplyModelPicker } from "@/components/chat/reply-model-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/ui/markdown"
import { Textarea } from "@/components/ui/textarea"
import { CancelIcon, LoadingIcon, SparklesIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  extractSource,
  extractSourceResponse,
} from "@/lib/client/extract-source"
import { cn } from "@/lib/utils"

/** Maximum context items accepted with one message. */
const MAX_ATTACHMENTS = 8
/** Maximum project collections accepted with one message. */
const MAX_PROJECT_ATTACHMENTS = 3
/** Maximum extracted characters retained for one browser-owned attachment. */
const MAX_ATTACHMENT_TEXT = 48_000
/** Maximum inline file and link text sent with one message. */
const MAX_INLINE_CONTEXT = 96_000

/** One unsent project, file, or public link shown above the composer. */
type DraftAttachment = {
  id: string
  kind: "project" | "file" | "link"
  label: string
  projectId?: Id<"projects">
  text?: string
  url?: string
}

/** Narrow event shapes returned by the workspace chat stream. */
type ChatEvent =
  | { type: "started"; chatId: Id<"workspaceChats"> }
  | { type: "delta"; text: string }
  | { type: "complete"; chatId: Id<"workspaceChats">; threadId: string }
  | { type: "error"; message: string }

/** Initial saved chat selected by the route query string. */
type ChatWorkspaceProps = { initialChatId?: Id<"workspaceChats"> }

/** Returns a readable error without exposing an arbitrary response object. */
function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

/** Parses one server event and rejects malformed stream data. */
function parseChatEvent(value: unknown): ChatEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex returned an invalid response.")
  const event = value as Record<string, unknown>
  if (event.type === "started" && typeof event.chatId === "string")
    return { type: "started", chatId: event.chatId as Id<"workspaceChats"> }
  if (event.type === "delta" && typeof event.text === "string")
    return { type: "delta", text: event.text }
  if (
    event.type === "complete" &&
    typeof event.chatId === "string" &&
    typeof event.threadId === "string"
  )
    return {
      type: "complete",
      chatId: event.chatId as Id<"workspaceChats">,
      threadId: event.threadId,
    }
  if (event.type === "error" && typeof event.message === "string")
    return { type: "error", message: event.message }
  throw new Error("Codex returned an invalid response.")
}

/** Reads newline-delimited events without assuming network chunk boundaries. */
async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let newline = pending.indexOf("\n")
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim()) onEvent(parseChatEvent(JSON.parse(line)))
        newline = pending.indexOf("\n")
      }
      if (done) break
    }
    if (pending.trim()) onEvent(parseChatEvent(JSON.parse(pending)))
  } finally {
    reader.releaseLock()
  }
}

/** Displays saved chat history beside the active conversation and composer. */
export function ChatWorkspace({ initialChatId }: ChatWorkspaceProps) {
  const projects = useQuery(api.projects.listProjects)
  const chats = useQuery(api.workspaceChats.list) as
    ChatHistoryItem[] | undefined
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const [activeChatId, setActiveChatId] = useState<
    Id<"workspaceChats"> | undefined
  >(initialChatId)
  const activeChat = useQuery(
    api.workspaceChats.get,
    activeChatId ? { chatId: activeChatId } : "skip"
  )
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [savingReplySettings, setSavingReplySettings] = useState(false)
  const [error, setError] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")
  const [importingLink, setImportingLink] = useState(false)
  const persistedAttachments = activeChat?.attachments ?? []
  const messages = activeChat?.messages ?? []
  const lastMessageContent = messages.at(-1)?.content
  const selectedProject = attachments.find(
    (attachment) => attachment.kind === "project" && attachment.projectId
  )
  const isRunning =
    sending || activeChat?.status === "running" || savingReplySettings
  const canAttach = attachments.length < MAX_ATTACHMENTS
  const canAttachProject =
    canAttach &&
    attachments.filter((attachment) => attachment.kind === "project").length <
      MAX_PROJECT_ATTACHMENTS

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages.length, lastMessageContent])

  /** Selects one saved chat and mirrors it in the address bar. */
  const selectChat = (chatId: Id<"workspaceChats">): void => {
    setActiveChatId(chatId)
    setAttachments([])
    setError("")
    setHistoryOpen(false)
    window.history.replaceState(
      null,
      "",
      `/chat?chatId=${encodeURIComponent(chatId)}`
    )
  }

  /** Opens an empty composer without deleting any saved conversation. */
  const startNewChat = (): void => {
    if (isRunning) return
    setActiveChatId(undefined)
    setAttachments([])
    setDraft("")
    setError("")
    setHistoryOpen(false)
    window.history.replaceState(null, "", "/chat")
  }

  /** Adds an unsent attachment unless the same project or URL is already selected. */
  const addAttachment = (attachment: DraftAttachment): void => {
    setAttachments((current) => {
      if (current.length >= MAX_ATTACHMENTS) return current
      if (
        current.some(
          (item) =>
            (attachment.projectId && item.projectId === attachment.projectId) ||
            (attachment.url && item.url === attachment.url)
        )
      )
        return current
      return [...current, attachment]
    })
  }

  /** Extracts supported local files and attaches their bounded text in selection order. */
  const chooseFiles = async (files: File[]): Promise<void> => {
    setError("")
    const selected = files.slice(
      0,
      Math.max(0, MAX_ATTACHMENTS - attachments.length)
    )
    let remainingCharacters =
      MAX_INLINE_CONTEXT -
      attachments.reduce(
        (total, attachment) => total + (attachment.text?.length ?? 0),
        0
      )
    for (const file of selected) {
      try {
        const source = await extractSource(file)
        if (!source.text.trim())
          throw new Error("There was no readable text in that file.")
        if (remainingCharacters <= 0)
          throw new Error("Remove a file or link before adding another.")
        const text = source.text.slice(
          0,
          Math.min(MAX_ATTACHMENT_TEXT, remainingCharacters)
        )
        remainingCharacters -= text.length
        addAttachment({
          id: crypto.randomUUID(),
          kind: "file",
          label: source.filename,
          text,
        })
      } catch (fileError) {
        setError(messageForError(fileError, `Could not read ${file.name}.`))
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  /** Fetches a public source through the protected route and attaches extracted text. */
  const attachLink = async (): Promise<void> => {
    const url = linkUrl.trim()
    if (!url || importingLink || !canAttach) return
    setImportingLink(true)
    setError("")
    try {
      const response = await fetch("/api/sources/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(result?.error || "That link could not be fetched.")
      }
      const source = await extractSourceResponse(response, url)
      if (!source.text.trim())
        throw new Error("There was no readable text at that link.")
      const remainingCharacters =
        MAX_INLINE_CONTEXT -
        attachments.reduce(
          (total, attachment) => total + (attachment.text?.length ?? 0),
          0
        )
      if (remainingCharacters <= 0)
        throw new Error("Remove a file or link before adding another.")
      addAttachment({
        id: crypto.randomUUID(),
        kind: "link",
        label: source.filename,
        text: source.text.slice(
          0,
          Math.min(MAX_ATTACHMENT_TEXT, remainingCharacters)
        ),
        url: response.headers.get("x-source-url") ?? url,
      })
      setLinkUrl("")
      setLinkDialogOpen(false)
    } catch (linkError) {
      setError(messageForError(linkError, "That link could not be attached."))
    } finally {
      setImportingLink(false)
    }
  }

  /** Sends one message and lets Convex snapshots drive the persistent transcript. */
  const sendMessage = async (): Promise<void> => {
    const message = draft.trim()
    if (!message || isRunning) return
    setDraft("")
    setError("")
    setSending(true)
    let started = false
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          clientMessageId: crypto.randomUUID(),
          ...(activeChatId ? { chatId: activeChatId } : {}),
          projectIds: attachments.flatMap((attachment) =>
            attachment.kind === "project" && attachment.projectId
              ? [attachment.projectId]
              : []
          ),
          attachments: attachments.flatMap((attachment) =>
            attachment.kind !== "project" && attachment.text
              ? [
                  {
                    kind: attachment.kind,
                    label: attachment.label,
                    text: attachment.text,
                    ...(attachment.url ? { url: attachment.url } : {}),
                  },
                ]
              : []
          ),
        }),
      })
      if (!response.ok || !response.body) {
        const result = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(result?.error || "Codex could not start that reply.")
      }
      await readChatEvents(response.body, (event) => {
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "started") {
          started = true
          setAttachments([])
          selectChat(event.chatId)
        }
      })
      if (!started && !activeChatId)
        throw new Error("Codex ended the reply early.")
    } catch (sendError) {
      setError(
        messageForError(
          sendError,
          "Codex could not finish that reply. Try again."
        )
      )
      if (!started) setDraft(message)
    } finally {
      setSending(false)
    }
  }

  /** Sends on Enter while keeping Shift+Enter available for a new line. */
  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const history = (
    <ChatHistory
      chats={chats}
      activeChatId={activeChatId}
      onSelect={selectChat}
      onNew={startNewChat}
    />
  )

  return (
    <main className="flex h-[calc(100svh-141px)] min-h-[560px] w-full overflow-hidden md:h-svh md:min-h-0">
      <aside className="hidden w-[276px] shrink-0 border-r border-border/70 bg-card/40 md:block">
        {history}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col px-4 sm:px-8">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full md:hidden"
              aria-label="Open chat history"
              onClick={() => setHistoryOpen(true)}
            >
              <HugeiconsIcon icon={Menu01Icon} size={18} strokeWidth={1.8} />
            </Button>
            <h1 className="truncate text-xl font-medium tracking-tight">
              {activeChat?.title ?? "New chat"}
            </h1>
          </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-full md:hidden"
            disabled={isRunning || (!activeChatId && !attachments.length)}
            onClick={startNewChat}
          >
            New chat
          </Button>
        </header>

        <section
          aria-label="Conversation"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto py-5"
        >
          {activeChatId && activeChat === undefined ? (
            <div
              className="m-auto flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
              Loading chat…
            </div>
          ) : activeChatId && activeChat === null ? (
            <div className="m-auto max-w-sm text-center">
              <h2 className="text-lg font-medium">Chat not found</h2>
              <Button variant="outline" className="mt-4" onClick={startNewChat}>
                Start a new chat
              </Button>
            </div>
          ) : !messages.length ? (
            <div className="m-auto max-w-xl px-4 py-12 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                <HugeiconsIcon
                  icon={BubbleChatIcon}
                  size={25}
                  strokeWidth={1.8}
                />
              </span>
              <h2 className="mt-5 text-2xl font-medium tracking-tight">
                {selectedProject?.projectId ? (
                  <>
                    Ask about{" "}
                    <Link
                      href={`/projects/${encodeURIComponent(selectedProject.projectId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {selectedProject.label}
                    </Link>
                  </>
                ) : (
                  "Ask about anything"
                )}
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Attach a project, PDF, notes, PowerPoint, or public link. Codex
                will use that material as context for the conversation.
              </p>
            </div>
          ) : (
            <div
              className="mx-auto flex w-full max-w-3xl flex-col gap-6"
              aria-live="polite"
            >
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    "max-w-[88%] text-sm leading-6 sm:max-w-[78%]",
                    message.role === "user"
                      ? "ml-auto rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-background"
                      : "mr-auto min-w-0",
                    message.status === "failed" && "text-destructive"
                  )}
                >
                  {message.role === "assistant" ? (
                    message.content ? (
                      <Markdown text={message.content} />
                    ) : message.status === "running" ? (
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                        Codex is reading your context…
                      </span>
                    ) : (
                      <p>
                        {activeChat?.lastError ||
                          "Codex could not finish this reply."}
                      </p>
                    )
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </article>
              ))}
              <div ref={messageEndRef} />
            </div>
          )}
        </section>

        <div className="mx-auto w-full max-w-3xl shrink-0 pb-3">
          {persistedAttachments.length || attachments.length ? (
            <ul
              aria-label="Attached context"
              className="mb-2 flex max-h-20 flex-wrap gap-2 overflow-y-auto"
            >
              {persistedAttachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  kind={attachment.kind}
                  label={attachment.label}
                  sent
                />
              ))}
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  kind={attachment.kind}
                  label={attachment.label}
                  onRemove={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id)
                    )
                  }
                />
              ))}
            </ul>
          ) : null}
          <div className="rounded-[24px] border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
            <Textarea
              aria-label="Message Codex"
              value={draft}
              maxLength={4_000}
              rows={2}
              disabled={isRunning}
              placeholder="Ask Codex about your material…"
              className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="flex items-center justify-between gap-3">
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                multiple
                accept=".pdf,.md,.markdown,.txt,.pptx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                onChange={(event) =>
                  void chooseFiles(Array.from(event.target.files ?? []))
                }
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    disabled={isRunning || !canAttach}
                    aria-label="Attach context"
                  >
                    <HugeiconsIcon
                      icon={Attachment02Icon}
                      size={19}
                      strokeWidth={1.8}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => fileInputRef.current?.click()}
                  >
                    <HugeiconsIcon icon={File01Icon} size={17} />
                    Upload file
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLinkDialogOpen(true)}>
                    <HugeiconsIcon icon={Link02Icon} size={17} />
                    Add link
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canAttachProject}
                    onSelect={() => setProjectDialogOpen(true)}
                  >
                    <HugeiconsIcon icon={Folder01Icon} size={17} />
                    Add project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ReplyModelPicker
                disabled={isRunning}
                onSaveStateChange={setSavingReplySettings}
              />
              <Button
                type="button"
                size="icon"
                aria-label="Send message"
                className="ml-auto rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                disabled={!draft.trim() || isRunning}
                onClick={() => void sendMessage()}
              >
                {isRunning ? (
                  <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <HugeiconsIcon icon={Sent02Icon} size={18} strokeWidth={2} />
                )}
              </Button>
            </div>
          </div>
          <div className="min-h-6 px-3 pt-1.5">
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-center text-[11px] text-muted-foreground">
                Codex can make mistakes. Check important details against your
                sources.
              </p>
            )}
          </div>
        </div>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="h-[min(680px,calc(100svh-2rem))] min-w-0 overflow-hidden p-0 sm:max-w-sm"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Chat history</DialogTitle>
          {history}
        </DialogContent>
      </Dialog>

      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent aria-describedby="project-chat-description">
          <DialogHeader>
            <DialogTitle>Attach a project</DialogTitle>
            <DialogDescription id="project-chat-description">
              Codex will read up to eight ready sources from the project.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 max-h-72 space-y-1 overflow-y-auto p-1">
            {projects === undefined ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                Loading projects…
              </p>
            ) : projects.length ? (
              projects.map((project) => {
                const attached = attachments.some(
                  (attachment) => attachment.projectId === project._id
                )
                return (
                  <Button
                    key={project._id}
                    type="button"
                    variant="ghost"
                    disabled={attached || !canAttachProject}
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                    onClick={() => {
                      addAttachment({
                        id: crypto.randomUUID(),
                        kind: "project",
                        label: project.title,
                        projectId: project._id,
                      })
                      setProjectDialogOpen(false)
                    }}
                  >
                    <HugeiconsIcon icon={Folder01Icon} size={18} />
                    <span className="min-w-0 flex-1 truncate">
                      {project.title}
                    </span>
                    {attached ? (
                      <span className="text-xs text-muted-foreground">
                        Attached
                      </span>
                    ) : null}
                  </Button>
                )
              })
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                Create a project in Library, then attach it here.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent aria-describedby="link-chat-description">
          <DialogHeader>
            <DialogTitle>Attach a public link</DialogTitle>
            <DialogDescription id="link-chat-description">
              Add a public webpage, PDF, text file, or PowerPoint link.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void attachLink()
            }}
          >
            <Input
              type="url"
              autoFocus
              required
              maxLength={2_048}
              disabled={importingLink}
              placeholder="https://example.com/notes.pdf"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
            />
            <Button
              type="submit"
              className="w-full bg-brand text-brand-foreground hover:bg-brand/85"
              disabled={!linkUrl.trim() || importingLink}
            >
              {importingLink ? (
                <>
                  <LoadingIcon className="animate-spin motion-reduce:animate-none" />
                  Reading link…
                </>
              ) : (
                <>
                  <SparklesIcon /> Attach link
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** Renders one persisted or removable attachment using the correct source icon. */
function AttachmentChip({
  kind,
  label,
  sent,
  onRemove,
}: {
  kind: "project" | "file" | "link"
  label: string
  sent?: boolean
  onRemove?: () => void
}) {
  return (
    <li className="flex max-w-full min-w-0 items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs">
      <HugeiconsIcon
        icon={
          kind === "project"
            ? Folder01Icon
            : kind === "link"
              ? Link02Icon
              : File01Icon
        }
        size={14}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="max-w-52 truncate">{label}</span>
      {sent ? (
        <span className="pr-2 text-muted-foreground">In chat</span>
      ) : (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={onRemove}
        >
          <CancelIcon className="size-3.5" />
        </button>
      )}
    </li>
  )
}
